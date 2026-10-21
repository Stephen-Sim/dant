package memory

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type cancellingSnapshotWriter struct {
	snapshotWriter
	cancel context.CancelFunc
}

func (file cancellingSnapshotWriter) Close() error {
	err := file.snapshotWriter.Close()
	file.cancel()
	return err
}

func TestCancellationAfterDurableBackupCannotAdoptOrMarkTheSourceImported(t *testing.T) {
	for _, kind := range []string{"legacy", "project"} {
		t.Run(kind, func(t *testing.T) {
			s := openStoreFixture(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			disk := s.snapshots
			s.snapshots.create = func(name string) (snapshotWriter, error) {
				file, err := disk.create(name)
				if err != nil {
					return nil, err
				}
				return cancellingSnapshotWriter{snapshotWriter: file, cancel: cancel}, nil
			}
			legacy := &legacyStateFixture{state: contracts.State{ConversationID: "conversation", Memory: "Synthetic complete legacy source"}}
			var err error
			if kind == "legacy" {
				err = s.MigrateLegacy(ctx, legacy)
			} else {
				err = s.MigrateProjects(ctx, "conversation", []contracts.WorkRecord{{ID: "work", Status: contracts.WorkStatusPaused, ProjectContext: contracts.RawObject{"version": json.RawMessage(`1`), "updatedAt": json.RawMessage(`1000`)}}})
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatal("cancelled source import became completed", err)
			}
			if text, err := s.ReadNote(t.Context(), "working-memory.md"); err != nil || text != "" || len(legacy.state.MemoryMigration) != 0 || legacy.state.Memory != "Synthetic complete legacy source" {
				t.Fatal("cancelled import changed notes or marked its source imported", err)
			}
			if project, err := s.ReadProject(t.Context(), "conversation", "work"); err != nil || project != nil {
				t.Fatal("cancelled project import escaped its transaction", err)
			}
			copies, err := filepath.Glob(filepath.Join(s.Directory(), "*-backup-*", "memory.json"))
			if err != nil || len(copies) != 1 {
				t.Fatal("cancellation discarded a completed original-source backup", err)
			}
			raw, err := os.ReadFile(copies[0])
			if err != nil || !json.Valid(raw) {
				t.Fatal("completed source backup was truncated or removed", err)
			}
		})
	}
}

func TestProjectBackupRejectsAnUnencodableSourceRecordBeforeWritingOrImporting(t *testing.T) {
	s := openStoreFixture(t)
	// Project context is valid, but this malformed source record lacks a
	// recognized work status. Its complete original cannot be serialized safely.
	record := contracts.WorkRecord{ID: "work", ProjectContext: contracts.RawObject{"version": json.RawMessage(`1`), "updatedAt": json.RawMessage(`1000`)}}
	if err := s.MigrateProjects(t.Context(), "conversation", []contracts.WorkRecord{record}); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("unencodable complete source was imported without a backup", err)
	}
	if project, err := s.ReadProject(t.Context(), "conversation", "work"); err != nil || project != nil {
		t.Fatal("unbacked malformed source changed canonical projects", err)
	}
	if copies, err := filepath.Glob(filepath.Join(s.Directory(), "projects-backup-*")); err != nil || len(copies) != 0 {
		t.Fatal("invalid complete source created a misleading backup artifact", err)
	}
}
