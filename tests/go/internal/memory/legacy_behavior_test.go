package memory

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type legacyStateFixture struct {
	state  contracts.State
	change func(*contracts.State)
}

func (fixture *legacyStateFixture) Snapshot() contracts.State { return fixture.state }
func (fixture *legacyStateFixture) Mutate(_ context.Context, change func(*contracts.State) error) error {
	if fixture.change != nil {
		fixture.change(&fixture.state)
	}
	return change(&fixture.state)
}

func TestLegacyMemoryImportKeepsOriginalBackupAndNeverOverwritesExistingNotes(t *testing.T) {
	for _, test := range []struct {
		name, legacy, existing string
		completed              bool
	}{
		{"new legacy", "A preserved legacy fact", "", false},
		{"bounded Unicode", strings.Repeat("界", MaxNoteBytes/3+1), "", false},
		{"existing note", "Old content", "Already adopted preference", false},
		{"completed import", "Must not import again", "Already adopted preference", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := openStoreFixture(t)
			if err := s.WriteNote(t.Context(), "working-memory.md", test.existing); err != nil {
				t.Fatal(err)
			}
			fixture := &legacyStateFixture{state: contracts.State{ConversationID: "conversation", Memory: test.legacy, MemoryMigration: contracts.RawObject{}}}
			if test.completed {
				fixture.state.MemoryMigration["version"] = json.RawMessage("1")
			}
			if err := s.MigrateLegacy(t.Context(), fixture); err != nil {
				t.Fatal(err)
			}
			current, err := s.ReadNote(t.Context(), "working-memory.md")
			if err != nil || current != fixture.state.Memory || len(current) > MaxNoteBytes || test.existing != "" && current != test.existing {
				t.Fatal("legacy import overwrote the current authority", err)
			}
			if !test.completed && string(fixture.state.MemoryMigration["version"]) != "1" {
				t.Fatal("successful import did not persist its revision")
			}
			backups, err := filepath.Glob(filepath.Join(s.Directory(), "legacy-state-backup-*", "memory.json"))
			if err != nil {
				t.Fatal(err)
			}
			if test.existing == "" && !test.completed {
				if len(backups) != 1 {
					t.Fatal("original legacy content was not backed up before replacement")
				}
				raw, err := os.ReadFile(backups[0])
				var original struct{ Memory string }
				if err != nil || json.Unmarshal(raw, &original) != nil || original.Memory != test.legacy {
					t.Fatal("backup lost the complete original UTF-8 data", err)
				}
			} else if len(backups) != 0 {
				t.Fatal("an already adopted note was backed up or imported again")
			}
		})
	}
}

func TestLegacyImportRejectsConversationChangesAndUnavailableAuthority(t *testing.T) {
	for _, completed := range []bool{false, true} {
		s := openStoreFixture(t)
		fixture := &legacyStateFixture{state: contracts.State{ConversationID: "original", MemoryMigration: contracts.RawObject{}}, change: func(state *contracts.State) { state.ConversationID = "replacement" }}
		if completed {
			fixture.state.MemoryMigration["version"] = json.RawMessage("1")
		}
		if err := s.MigrateLegacy(t.Context(), fixture); !errors.Is(err, ErrConflict) {
			t.Fatal("stale startup snapshot changed a replacement conversation", err)
		}
	}
	s := openStoreFixture(t)
	if err := s.MigrateProjects(t.Context(), "", nil); !errors.Is(err, ErrInvalidScope) {
		t.Fatal("unscoped project import was accepted", err)
	}
	if err := s.MigrateProjects(t.Context(), "conversation", []contracts.WorkRecord{{ID: "empty"}, {ID: "bad id", ProjectContext: contracts.RawObject{"version": json.RawMessage("1")}}}); !errors.Is(err, ErrInvalidScope) {
		t.Fatal("invalid work identity was imported", err)
	}
	s.Close()
	if err := s.MigrateLegacy(t.Context(), &legacyStateFixture{state: contracts.State{ConversationID: "conversation"}}); !errors.Is(err, ErrUnavailable) {
		t.Fatal("closed authority was treated as migrated", err)
	}
}
