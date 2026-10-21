package backups

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestRestorePathsAndLockRejectUnownedLocations(t *testing.T) {
	for _, mode := range []string{"relative", "data-parent", "workspace-parent", "kernel-directory", "lock-directory", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			options := restoreFixture(t)
			locations, err := restoreLocations(options)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch mode {
			case "relative":
				options.DataDir = "relative"
			case "data-parent":
				options.DataDir = filepath.Join(t.TempDir(), "missing", "data")
			case "workspace-parent":
				options.WorkspaceRoot = filepath.Join(t.TempDir(), "missing", "workspace")
			case "kernel-directory":
				if err := os.Mkdir(locations.kernel, 0700); err != nil {
					t.Fatal(err)
				}
			case "lock-directory":
				if err := os.Mkdir(locations.lock, 0700); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				cancel()
			}
			called := false
			if err := withRestoreLock(ctx, options, func(restorePaths) error {
				called = true
				return nil
			}); err == nil || called {
				t.Fatal("invalid ownership boundary reached the restore operation")
			}
		})
	}
}

func TestRestoreJournalRejectsInvalidWritesAndPreservesUnownedCleanup(t *testing.T) {
	options := restoreFixture(t)
	locations, err := restoreLocations(options)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{make(chan int), map[string]string{"large": strings.Repeat("x", restoreJournalMaxBytes)}} {
		if !errors.Is(writeRestoreJSON(t.Context(), locations.journal, value), ErrRestoreFailed) {
			t.Fatal("unserializable or oversized journal was persisted")
		}
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if !errors.Is(writeRestoreJSON(cancelled, locations.journal, map[string]int{"value": 1}), ErrRestoreFailed) {
		t.Fatal("cancelled journal write committed")
	}
	for _, raw := range []string{`{"restoreId":1}`, `{"restoreId":"x","restoreId":"x"}`} {
		if err := os.WriteFile(locations.journal, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readJournal(locations.journal); !errors.Is(err, ErrRestoreFailed) {
			t.Fatal("typed or duplicate journal fields were accepted")
		}
	}
	if !errors.Is(removeRestoreDirectory(locations, locations.data), ErrRestoreFailed) {
		t.Fatal("cleanup accepted the live data root")
	}
	if err := os.WriteFile(locations.dataNew, []byte("evidence"), 0600); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(removeRestoreDirectory(locations, locations.dataNew), ErrRestoreFailed) {
		t.Fatal("cleanup removed a non-directory staging replacement")
	}
	if raw, err := os.ReadFile(locations.dataNew); err != nil || string(raw) != "evidence" {
		t.Fatal("rejected cleanup destroyed unowned evidence")
	}
	if !errors.Is(clearJournal(filepath.Join(t.TempDir(), "missing")), ErrRestoreFailed) {
		t.Fatal("missing journal was treated as a confirmed clear")
	}
}

func TestRestoreInspectionNeverInventsACommittedOrRejectedReceipt(t *testing.T) {
	for _, mode := range []string{"invalid-options", "journal-invalid", "journal-pending", "proof-invalid", "data-missing", "workspace-missing", "receipt-invalid", "receipt-uncommitted"} {
		t.Run(mode, func(t *testing.T) {
			options := restoreFixture(t)
			locations, journal := recoveryJournalFixture(t, options, contracts.WorkerRestorePhasePrepared)
			if err := os.Remove(locations.journal); err != nil {
				t.Fatal(err)
			}
			proof := rejectionProof{RestoreRejection: RestoreRejection{Rejected: true, RestoreID: options.RestoreID}, Data: journal.Data, Workspace: journal.Workspace}
			if err := writeRestoreJSON(t.Context(), locations.rejection, proof); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "invalid-options":
				options.RestoreID = "invalid"
			case "journal-invalid":
				if err := os.WriteFile(locations.journal, []byte("invalid"), 0600); err != nil {
					t.Fatal(err)
				}
			case "journal-pending":
				if err := writeRestoreJSON(t.Context(), locations.journal, journal); err != nil {
					t.Fatal(err)
				}
			case "proof-invalid":
				if err := os.WriteFile(locations.rejection, []byte(`{"rejected":"yes"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "data-missing":
				if err := os.Rename(locations.data, locations.data+".retained"); err != nil {
					t.Fatal(err)
				}
			case "workspace-missing":
				if err := os.Rename(locations.workspace, locations.workspace+".retained"); err != nil {
					t.Fatal(err)
				}
			case "receipt-invalid", "receipt-uncommitted":
				raw := []byte("invalid")
				if mode == "receipt-uncommitted" {
					raw = []byte(`{"restored":false,"restoreId":"` + options.RestoreID + `"}`)
				}
				if err := os.WriteFile(filepath.Join(locations.data, WorkerRestoreReceiptFile), raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			result, err := InspectWorkerRestoreRejection(options)
			if mode == "journal-pending" {
				if err != nil || result.Rejected {
					t.Fatal("pending journal became a confirmed rejection")
				}
			} else if mode != "receipt-uncommitted" && err == nil {
				t.Fatal("invalid receipt or changed roots were accepted")
			}
			if mode == "receipt-invalid" || mode == "receipt-uncommitted" {
				if _, err := LoadedWorkerRestoreInfo(options.DataDir, options.WorkspaceRoot); !errors.Is(err, ErrRestoreFailed) {
					t.Fatal("loaded state invented a committed receipt")
				}
			}
		})
	}
	options := restoreFixture(t)
	if result, err := LoadedWorkerRestoreInfo(options.DataDir, options.WorkspaceRoot); err != nil || result.Restored || result.RestoreID != nil {
		t.Fatal("fresh data invented a restore identity")
	}
	options.AssertOffline = nil
	if _, err := RecoverWorkerRestore(t.Context(), options); !errors.Is(err, ErrBusy) {
		t.Fatal("recovery ran without proof that the worker is stopped")
	}
	if _, err := InspectWorkerRestore(RestoreOptions{}); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid inspection options were accepted")
	}
}

func TestRestoreTreeRejectsChangedOrCancelledInputBeforeCommitting(t *testing.T) {
	for _, mode := range []string{"missing", "destination", "cancelled", "hardlink"} {
		t.Run(mode, func(t *testing.T) {
			source := t.TempDir()
			destination := filepath.Join(t.TempDir(), "candidate")
			name := filepath.Join(source, "retained.bin")
			if err := os.WriteFile(name, []byte{0, 255, 17}, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch mode {
			case "missing":
				source = filepath.Join(source, "missing")
			case "destination":
				if err := os.Mkdir(destination, 0700); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				cancel()
			case "hardlink":
				if err := os.Link(name, filepath.Join(t.TempDir(), "evidence.bin")); err != nil {
					t.Fatal(err)
				}
			}
			if err := copyRestoreTree(ctx, source, destination); err == nil {
				t.Fatal("unsafe tree copy succeeded")
			}
			if mode != "destination" {
				if err := flushRestoreTree(ctx, source); err == nil {
					t.Fatal("unsafe tree was accepted as flushed")
				}
			}
			if raw, err := os.ReadFile(name); err != nil || !bytes.Equal(raw, []byte{0, 255, 17}) {
				t.Fatal("failed tree preparation changed source bytes")
			}
		})
	}
}

func TestWorkerRestorePreSwapFailureRetainsBothOriginalRoots(t *testing.T) {
	for _, mode := range []string{"pending-recovery", "rejection-directory", "staging-exists", "validation-state", "offline-changed"} {
		t.Run(mode, func(t *testing.T) {
			options := restoreFixture(t)
			locations, err := restoreLocations(options)
			if err != nil {
				t.Fatal(err)
			}
			input := fixtureArchive([]byte(restoreFixtureState))
			switch mode {
			case "pending-recovery":
				recoveryJournalFixture(t, options, contracts.WorkerRestorePhaseInstalling)
				options.Rename = func(context.Context, string, string) error { return io.ErrUnexpectedEOF }
				if err := os.Rename(locations.data, locations.dataPrevious); err != nil {
					t.Fatal(err)
				}
			case "rejection-directory":
				if err := os.Mkdir(locations.rejection, 0700); err != nil {
					t.Fatal(err)
				}
			case "staging-exists":
				if err := os.Mkdir(locations.workspaceNew, 0700); err != nil {
					t.Fatal(err)
				}
			case "validation-state":
				input = fixtureArchive([]byte("invalid state"))
			case "offline-changed":
				checks := 0
				options.AssertOffline = func(context.Context) error {
					checks++
					if checks > 1 {
						return ErrBusy
					}
					return nil
				}
			}
			if _, err := RestoreWorkerBackup(t.Context(), options, bytes.NewReader(input)); err == nil {
				t.Fatal("failed pre-swap preparation committed live roots")
			}
			data := locations.data
			if mode == "pending-recovery" {
				data = locations.dataPrevious
			}
			for root, want := range map[string]string{data: "original data", locations.workspace: "original workspace"} {
				raw, err := os.ReadFile(filepath.Join(root, "original"))
				if err != nil || string(raw) != want {
					t.Fatal("pre-swap failure destroyed the original data or workspace")
				}
			}
		})
	}
}
