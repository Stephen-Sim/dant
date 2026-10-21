package app

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/ownership"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func TestWorkerStartupPersistenceFailureReleasesMemoryAndProcessOwnership(t *testing.T) {
	for _, stage := range []string{"legacy-state-projection", "skills-workspace"} {
		t.Run(stage, func(t *testing.T) {
			options := fixtureWorkerOptions(t)
			var writes atomic.Int32
			privateFailure := errors.New("isolated startup persistence failure")
			if stage == "legacy-state-projection" {
				options.StoreOptions.Write = func(ctx context.Context, name string, raw []byte, mode fs.FileMode) error {
					if writes.Add(1) == 2 {
						return privateFailure
					}
					return files.WriteAtomic(ctx, name, raw, mode)
				}
			} else {
				if err := os.MkdirAll(filepath.Dir(options.Startup.WorkspaceRoot), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(options.Startup.WorkspaceRoot, []byte("occupied isolated workspace"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			app, err := NewWorker(t.Context(), options)
			if err == nil || app == nil {
				if app != nil {
					app.Close()
				}
				t.Fatal("startup failure produced a usable Worker")
			}
			app.Close()
			if stage == "legacy-state-projection" && (!errors.Is(err, store.ErrPersistence) || writes.Load() != 2 || app.memory == nil) {
				t.Fatal("legacy projection failed outside its intended durable boundary", err)
			}
			if app.worker != nil || app.calls != nil {
				t.Fatal("storage assembly failure created an executor or call")
			}
			lock, err := ownership.Acquire(t.Context(), options.Startup.DataDir)
			if err != nil {
				t.Fatal("failed startup retained process ownership", err)
			}
			if err := lock.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWorkerAssembledMemoryUsesTheExactExistingWorkScope(t *testing.T) {
	app := fixtureWorker(t)
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "original scoped request"})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := workstate.PublicPlan([]contracts.PlanStep{{Step: "retain scoped context", Status: contracts.PlanStepStatusPending}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	record, err := app.store.RegisterWork(t.Context(), store.RegisterWorkOptions{
		TurnID: "captured-memory-turn", MessageID: message.ID, Source: "chat", Title: "scoped memory task", Plan: &plan,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.engine.MemoryReference(t.Context(), message, record.ID, message.Text); err != nil {
		t.Fatal("assembled memory rejected an existing exact work identity", err)
	}
	before := app.store.Revision()
	if _, err := app.engine.MemoryReference(t.Context(), message, "retired-work", message.Text); err == nil {
		t.Fatal("unknown work identity was adopted into memory scope")
	}
	if app.store.Revision() != before || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("memory reference created work or mutated durable ownership")
	}
}
