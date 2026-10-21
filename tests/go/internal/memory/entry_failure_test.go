package memory

import (
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"testing"
	"time"
)

func TestEntryUpdatesValidateWholePatchBeforeChangingDurableMemory(t *testing.T) {
	s := openStoreFixture(t)
	entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "Original preference", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, patch := range []EntryPatch{
		{}, {"unknown": json.RawMessage(`true`)}, {"kind": json.RawMessage(`"project"`)}, {"kind": json.RawMessage(`false`)}, {"text": json.RawMessage(`""`)}, {"text": json.RawMessage(`false`)}, {"key": json.RawMessage(`""`)}, {"key": json.RawMessage(`false`)}, {"source": json.RawMessage(`{}`)}, {"source": json.RawMessage(`false`)}, {"confidence": json.RawMessage(`2`)}, {"confidence": json.RawMessage(`"high"`)},
	} {
		if _, err := s.Update(t.Context(), entry.ID, patch); !errors.Is(err, ErrInvalidMemory) {
			t.Fatal("invalid patch was accepted", err)
		}
	}
	updated, err := s.Update(t.Context(), entry.ID, EntryPatch{"kind": json.RawMessage(`"episodic"`), "key": json.RawMessage(`" New KEY "`), "confidence": json.RawMessage(`null`)})
	if err != nil || updated.Kind != "episodic" || updated.Key != "new key" || updated.Confidence != nil || updated.Text != entry.Text {
		t.Fatal("valid metadata update changed authored content or omitted null", updated, err)
	}
	for _, id := range []string{"", "missing"} {
		if _, err := s.Update(t.Context(), id, EntryPatch{"text": json.RawMessage(`"replacement"`)}); err == nil {
			t.Fatal("update invented an entry")
		}
		if _, err := s.Confirm(t.Context(), id, false); err == nil {
			t.Fatal("confirmation invented an entry")
		}
	}
	if _, err := s.Delete(t.Context(), ""); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("invalid deletion identity accepted", err)
	}
	if deleted, err := s.Delete(t.Context(), "missing"); err != nil || deleted {
		t.Fatal("missing deletion fabricated a change", deleted, err)
	}
	for _, proposal := range []Proposal{
		{Kind: "other", Text: "fixture", Source: Source{Kind: "user"}},
		{Kind: "semantic", Text: "fixture", Source: Source{Kind: "unknown"}},
		{Kind: "semantic", Text: "fixture", Source: Source{Kind: "user"}, Confidence: ptr(math.NaN())},
		{Kind: "semantic", Text: "fixture", Source: Source{Kind: "user"}, Key: ptr("")},
	} {
		if _, err := s.Propose(t.Context(), proposal); !errors.Is(err, ErrInvalidMemory) {
			t.Fatal("invalid proposal accepted", err)
		}
	}
	s.now = func() time.Time { return time.UnixMilli(0) }
	if _, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "A new record", Source: Source{Kind: "user"}}); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("invalid creation clock accepted", err)
	}
	if _, err := s.Confirm(t.Context(), entry.ID, false); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("invalid confirmation clock accepted", err)
	}
	if _, err := s.Update(t.Context(), entry.ID, EntryPatch{"text": json.RawMessage(`"replacement"`)}); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("invalid update clock accepted", err)
	}
}

func TestMemoryReadsRejectCorruptedStoredEntryWithoutReturningPartialRecords(t *testing.T) {
	for _, test := range []struct{ name, sql string }{
		{"source", `UPDATE memory_entries SET source_json='{}'`},
		{"conflicts null", `UPDATE memory_entries SET conflicts_json='null'`},
		{"conflicts malformed", `UPDATE memory_entries SET conflicts_json='['`},
		{"conflict identity", `UPDATE memory_entries SET conflicts_json='["bad id"]'`},
		{"created time", `UPDATE memory_entries SET created_at=-1`},
		{"identity", `UPDATE memory_entries SET id='bad id'`},
		{"empty text", `UPDATE memory_entries SET text=''`},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := openStoreFixture(t)
			if _, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "A valid memory", Source: Source{Kind: "user"}}); err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", s.DatabaseFile())
			if err != nil {
				t.Fatal(err)
			}
			if _, err = db.Exec(test.sql); err != nil {
				db.Close()
				t.Fatal(err)
			}
			db.Close()
			if records, err := s.Entries(t.Context(), ""); !errors.Is(err, ErrInvalidSnapshot) || len(records) != 0 {
				t.Fatal("corrupt disk row escaped its owning validator", err)
			}
		})
	}
}
