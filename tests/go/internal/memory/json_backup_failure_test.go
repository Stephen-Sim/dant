package memory

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestJSONBackupFailureNeverAdoptsUnbackedLegacyOrProjectState(t *testing.T) {
	for _, kind := range []string{"legacy", "project"} {
		for _, phase := range []string{"mkdir", "create", "write", "short write", "sync", "close"} {
			t.Run(kind+"/"+phase, func(t *testing.T) {
				s := openStoreFixture(t)
				disk := s.snapshots
				created, closed := 0, 0
				if phase == "mkdir" {
					s.snapshots.mkdir = func(string, fs.FileMode) error {
						return errors.New("private isolated JSON backup failure")
					}
				}
				s.snapshots.create = func(path string) (snapshotWriter, error) {
					created++
					if phase == "create" {
						return nil, errors.New("private isolated JSON backup creation failure")
					}
					handle, err := disk.create(path)
					if err != nil {
						return nil, err
					}
					return snapshotWriteFailure{handle, phase, &closed}, nil
				}

				legacy := &legacyStateFixture{state: contracts.State{ConversationID: "conversation", Memory: "Synthetic original legacy note"}}
				records := []contracts.WorkRecord{{ID: "work", Status: contracts.WorkStatusPaused, ProjectContext: contracts.RawObject{"version": json.RawMessage(`1`), "updatedAt": json.RawMessage(`1000`), "originalRequest": json.RawMessage(`{"messageId":"request","at":1000,"text":"Synthetic retained source project","attachments":[]}`)}}}
				before, err := json.Marshal(records)
				if err != nil {
					t.Fatal(err)
				}
				if kind == "legacy" {
					err = s.MigrateLegacy(t.Context(), legacy)
				} else {
					err = s.MigrateProjects(t.Context(), "conversation", records)
				}
				if err == nil {
					t.Fatal("incomplete JSON backup reported a completed import")
				}
				if phase != "mkdir" && created != 1 || phase != "mkdir" && phase != "create" && closed != 1 {
					t.Fatal("failed JSON backup retried creation or leaked its file")
				}
				if text, err := s.ReadNote(t.Context(), "working-memory.md"); err != nil || text != "" || legacy.state.Memory != "Synthetic original legacy note" || len(legacy.state.MemoryMigration) != 0 {
					t.Fatal("failed backup replaced canonical notes or marked the source migrated", err)
				}
				if project, err := s.ReadProject(t.Context(), "conversation", "work"); err != nil || project != nil {
					t.Fatal("unbacked source project was adopted", err)
				}
				after, err := json.Marshal(records)
				if err != nil || !bytes.Equal(before, after) {
					t.Fatal("failed JSON backup altered its complete original project source", err)
				}
				copies, err := filepath.Glob(filepath.Join(s.Directory(), "*-backup-*", "memory.json"))
				if err != nil {
					t.Fatal(err)
				}
				if phase != "mkdir" && phase != "create" {
					if len(copies) != 1 {
						t.Fatal("failed JSON backup discarded its unfinished artifact")
					}
					if _, err := os.ReadFile(copies[0]); err != nil {
						t.Fatal("unfinished backup artifact was not retained", err)
					}
				}
			})
		}
	}
}
