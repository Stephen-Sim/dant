package memory

import (
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestMemoryEntryCapacityAndIdentityFailuresDoNotAllocatePartialRecords(t *testing.T) {
	for _, boundary := range []string{"capacity", "invalid generated identity"} {
		t.Run(boundary, func(t *testing.T) {
			s := openStoreFixture(t)
			if boundary == "capacity" {
				memoryFixtureSQL(t, s, `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n < ?) INSERT INTO memory_entries(id,kind,text,memory_key,dedupe,status,source_json,conflicts_json,created_at,updated_at) SELECT 'capacity-'||n,'semantic','Synthetic bounded record '||n,'capacity-'||n,'capacity-'||n,'candidate','{"kind":"user"}','[]',1000,1000 FROM sequence`, MaxEntries)
			} else {
				s.newID = func() string { return "invalid generated identity" }
			}

			before, err := s.ManagementSnapshot(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "New synthetic bounded fact", Source: Source{Kind: "user"}}); !errors.Is(err, ErrInvalidMemory) || entry != nil {
				t.Fatal("invalid generated identity or full entry budget allocated memory", err)
			}
			after, err := s.ManagementSnapshot(t.Context())
			if err != nil || after.Revision != before.Revision || len(after.Entries) != len(before.Entries) {
				t.Fatal("rejected entry allocation changed committed memory", err)
			}
		})
	}
}

func TestConflictResolutionWriteFailureKeepsBothPreviouslyCommittedStatuses(t *testing.T) {
	s := openStoreFixture(t)
	key := "synthetic shared preference"
	prior, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Key: &key, Text: "Original synthetic preference", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Confirm(t.Context(), prior.ID, false); err != nil {
		t.Fatal(err)
	}
	next, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Key: &key, Text: "Replacement synthetic preference", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	memoryFixtureSQL(t, s, `CREATE TRIGGER isolated_resolution_failure BEFORE UPDATE ON memory_entries WHEN NEW.status='rejected' BEGIN SELECT RAISE(ABORT,'synthetic-private-write-error'); END`)
	before, err := s.ManagementSnapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.Confirm(t.Context(), next.ID, true); !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "synthetic-private-write-error") {
		t.Fatal("conflict-resolution write failure was reported saved or exposed SQL details", err)
	}
	after, err := s.ManagementSnapshot(t.Context())
	if err != nil || after.Revision != before.Revision || len(after.Entries) != 2 {
		t.Fatal("failed conflict resolution partly changed memory", err)
	}
	for _, entry := range after.Entries {
		if entry.ID == prior.ID && entry.Status != contracts.MemoryEntryStatusConfirmed || entry.ID == next.ID && entry.Status != contracts.MemoryEntryStatusConflicted {
			t.Fatal("failed conflict resolution changed a previously committed status")
		}
	}
}

func TestInvalidStoredConflictIdentityCannotConfirmOrModifyAnUnrelatedCandidate(t *testing.T) {
	s := openStoreFixture(t)
	key := "synthetic conflict boundary"
	prior, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Key: &key, Text: "Original synthetic fact", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Confirm(t.Context(), prior.ID, false); err != nil {
		t.Fatal(err)
	}
	next, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Key: &key, Text: "Candidate synthetic fact", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	memoryFixtureSQL(t, s, "UPDATE memory_entries SET id='invalid stored identity' WHERE id=?", prior.ID)

	if _, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Key: &key, Text: "Another synthetic candidate", Source: Source{Kind: "user"}}); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("invalid conflict identity was accepted during proposal", err)
	}
	if _, err := s.Confirm(t.Context(), next.ID, true); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("invalid conflict identity authorized rejection of another record", err)
	}
	if _, err := s.Update(t.Context(), next.ID, EntryPatch{"text": []byte(`"Changed synthetic candidate"`)}); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("candidate update accepted invalid conflict ownership", err)
	}
}
