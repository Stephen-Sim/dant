package memory

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestEntryLifecyclePreservesIdentitySourceConfidenceAndTimestamps(t *testing.T) {
	ctx := t.Context()
	root := t.TempDir()
	now := int64(1760000000010)
	identities := []string{"7ea20f1d-d44f-4d8d-8ccf-80a27afdbc0c", "c9b22dd3-21fb-45c3-9040-5b187474bf6d", "21b5f01e-227c-4f7e-a5a7-e2f5f7fc7f90"}
	issued := 0
	store, err := OpenStore(ctx, root, StoreOptions{
		Now: func() time.Time { return time.UnixMilli(now) },
		NewID: func() string {
			if issued >= len(identities) {
				t.Fatal("duplicate proposal allocated a new identity")
			}
			id := identities[issued]
			issued++
			return id
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })

	initial, err := store.Propose(ctx, Proposal{Kind: "semantic", Text: "\ufeffRenderer ΟΣ İ ＡＢＣ\ufeff", Source: Source{Kind: "user", At: ptr(int64(1000))}, Confidence: ptr(0.0)})
	if err != nil || initial.ID != identities[0] || initial.Text != "Renderer ΟΣ İ ＡＢＣ" || initial.Key != "renderer ος i̇ abc" || initial.CreatedAt != now || initial.UpdatedAt != now || initial.Confidence == nil || *initial.Confidence != 0 {
		t.Fatal("proposal lost exact normalized identity or zero confidence", err)
	}
	now += 10
	duplicate, err := store.Propose(ctx, Proposal{Kind: "semantic", Text: " Renderer ΟΣ İ ＡＢＣ ", Source: Source{Kind: "user", At: ptr(int64(1001))}, Confidence: ptr(1.0)})
	if err != nil || !reflect.DeepEqual(initial, duplicate) || issued != 1 {
		t.Fatal("deduplication changed the existing record", err)
	}
	now += 10
	confirmed, err := store.Confirm(ctx, initial.ID, false)
	if err != nil || confirmed.Status != contracts.MemoryEntryStatusConfirmed || confirmed.CreatedAt != initial.CreatedAt || confirmed.UpdatedAt != now {
		t.Fatal("confirmation changed record creation identity", err)
	}
	now += 10
	replacement, err := store.Propose(ctx, Proposal{Kind: "semantic", Text: "Renderer prefers Rust", Key: &initial.Key, Source: Source{Kind: "inference"}})
	if err != nil || replacement.Status != contracts.MemoryEntryStatusConflicted || !slices.Equal(replacement.ConflictsWith, []string{initial.ID}) || replacement.Confidence != nil {
		t.Fatal("conflicting proposal was silently accepted", err)
	}
	if _, err = store.Confirm(ctx, replacement.ID, false); !errors.Is(err, ErrConflict) {
		t.Fatal("confirmation discarded a conflict without resolution", err)
	}
	now += 10
	replacement, err = store.Confirm(ctx, replacement.ID, true)
	if err != nil || replacement.Status != contracts.MemoryEntryStatusConfirmed || len(replacement.ConflictsWith) != 0 {
		t.Fatal("explicit conflict resolution failed", err)
	}
	now += 10
	updated, err := store.Update(ctx, replacement.ID, EntryPatch{
		"text":       json.RawMessage(`"Renderer prefers Go"`),
		"source":     json.RawMessage(`{"kind":"task","conversationId":"fixture-conv","workId":"fixture-work"}`),
		"confidence": json.RawMessage(`0.5`),
	})
	if err != nil || updated.Status != contracts.MemoryEntryStatusCandidate || updated.ID != replacement.ID || updated.CreatedAt != replacement.CreatedAt || updated.UpdatedAt != now || updated.Confidence == nil || *updated.Confidence != 0.5 || updated.Source.ConversationID == nil || *updated.Source.ConversationID != "fixture-conv" {
		t.Fatal("editing failed to reset confirmation or preserve exact metadata", err)
	}
	for _, key := range []string{"text", "source"} {
		if _, err := store.Update(ctx, updated.ID, EntryPatch{key: json.RawMessage("null")}); !errors.Is(err, ErrInvalidMemory) {
			t.Fatal("null erased a required entry field", err)
		}
	}
	after, err := store.Entries(ctx, "")
	if err != nil || len(after) != 2 || !reflect.DeepEqual(after[0], *updated) || after[1].Status != contracts.MemoryEntryStatusRejected {
		t.Fatal("rejected edit changed persisted content or conflict resolution", err)
	}
	now += 10
	episode, err := store.Propose(ctx, Proposal{
		Kind: "episodic", Text: "Stored task result",
		Source: Source{Kind: "task", ConversationID: ptr("fixture-conv"), WorkID: ptr("fixture-work"), At: ptr(int64(1000))},
	})
	if err != nil || episode.ID != identities[2] || episode.Kind != "episodic" || episode.Status != contracts.MemoryEntryStatusCandidate || episode.Confidence != nil || episode.CreatedAt != now || episode.UpdatedAt != now || episode.Source.WorkID == nil || *episode.Source.WorkID != "fixture-work" {
		t.Fatal("episodic proposal lost scope or invented confidence", err)
	}
	after, err = store.Entries(ctx, "")
	if err != nil || len(after) != 3 || !reflect.DeepEqual(after[0], *episode) {
		t.Fatal("entry ordering did not follow persisted update time", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(ctx, root, StoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restored, err := reopened.Entries(context.Background(), "")
	if err != nil || !reflect.DeepEqual(after, restored) {
		t.Fatal("disk reopen changed entry metadata", err)
	}
}
