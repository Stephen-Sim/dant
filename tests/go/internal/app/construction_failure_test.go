package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/ownership"
)

func TestWorkerConstructionFailureReleasesItsPartialOwnershipWithoutConnecting(t *testing.T) {
	for _, test := range []struct {
		name    string
		prepare func(*testing.T, *WorkerOptions)
	}{
		{"memory directory", func(t *testing.T, options *WorkerOptions) {
			rejectWorkerDirectory(t, options.Startup.DataDir, "memory")
		}},
		{"attachment directory", func(t *testing.T, options *WorkerOptions) {
			rejectWorkerDirectory(t, options.Startup.DataDir, "attachments")
		}},
		{"schedule directory", func(t *testing.T, options *WorkerOptions) {
			rejectWorkerDirectory(t, options.Startup.DataDir, "schedules")
		}},
		{"invalid guest transport", func(_ *testing.T, options *WorkerOptions) {
			options.Startup.Network.Guest.HTTPOrigin = "https://foreign.invalid"
		}},
		{"invalid auth listener", func(_ *testing.T, options *WorkerOptions) { options.Startup.Listen.Port = 0 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			options := fixtureWorkerOptions(t)
			test.prepare(t, &options)
			app, err := NewWorker(t.Context(), options)
			if err == nil {
				if app != nil {
					app.Close()
				}
				t.Fatal("invalid boundary was accepted during Worker construction")
			}
			if app != nil {
				app.Close()
				if app.calls != nil && app.calls.Snapshot() != nil {
					t.Fatal("failed assembly created a live call")
				}
			}
			lock, err := ownership.Acquire(t.Context(), options.Startup.DataDir)
			if err != nil {
				t.Fatal("failed assembly retained runtime ownership", err)
			}
			if err := lock.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func rejectWorkerDirectory(t *testing.T, root, name string) {
	t.Helper()
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, name), []byte("isolated occupied path"), 0600); err != nil {
		t.Fatal(err)
	}
}
