package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/ownership"
)

func TestPreparationRejectsInvalidPhaseRootsAndBackupBeforePublishingProof(t *testing.T) {
	for _, mode := range []string{"phase", "target", "backup", "unknown-field"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newActivationFixture(t)
			switch mode {
			case "phase":
				fixture.attempt.Phase = contracts.WorkerInstallationPhaseCommitted
				fixture.writeAttempt(t)
			case "target":
				if err := os.Rename(fixture.startup.Root, fixture.startup.Root+".retained"); err != nil {
					t.Fatal(err)
				}
			case "backup":
				if err := os.WriteFile(fixture.startup.Backup, []byte("changed backup"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "unknown-field":
				raw, err := json.Marshal(fixture.attempt)
				if err != nil {
					t.Fatal(err)
				}
				raw = append(raw[:len(raw)-1], []byte(`,"unrecognized":true}`)...)
				if err := os.WriteFile(filepath.Join(fixture.root, installationJournal), raw, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := beginPreparation(t.Context(), fixture.startup, fixture.attempt.Version, fixture.attempt.SourceCommit); !errors.Is(err, ErrActivation) {
				t.Fatal("unconfirmed installation acquired a preparation ticket", err)
			}
			if _, err := os.Lstat(filepath.Join(fixture.root, preparationFile)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("refused preparation published a receipt", err)
			}
			if raw, err := os.ReadFile(filepath.Join(fixture.startup.DataDir, "state.json")); err != nil || !bytes.Equal(raw, fixture.state) {
				t.Fatal("refused preparation changed conversation data", err)
			}
		})
	}
}

func TestPreparationTicketRejectsCancellationAndChangedBackupIdentity(t *testing.T) {
	fixture := newActivationFixture(t)
	ticket, err := beginPreparation(t.Context(), fixture.startup, fixture.attempt.Version, fixture.attempt.SourceCommit)
	if err != nil || ticket == nil {
		t.Fatal(err)
	}
	var absent *preparationTicket
	if err := absent.finish(t.Context(), ""); err != nil {
		t.Fatal("manual installation invented a preparation receipt", err)
	}
	if err := ticket.finish(t.Context(), "invalid"); !errors.Is(err, ErrActivation) {
		t.Fatal("invalid archive hash was published", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := absent.current(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatal("manual preparation ignored caller cancellation", err)
	}
	if err := ticket.finish(cancelled, strings.Repeat("b", 64)); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled ticket published a receipt", err)
	}
	if err := os.Rename(fixture.startup.Backup, fixture.startup.Backup+".retained"); err != nil {
		t.Fatal(err)
	}
	if err := ticket.current(t.Context()); !errors.Is(err, ErrActivation) {
		t.Fatal("missing recovery archive retained preparation ownership", err)
	}
	if err := ticket.finish(t.Context(), strings.Repeat("b", 64)); !errors.Is(err, ErrActivation) {
		t.Fatal("lost preparation ownership published success", err)
	}
}

func TestActivationRequiresOrdinaryManagedRootsAndValidNativeBackupIdentity(t *testing.T) {
	fixture := newActivationFixture(t)
	for _, mode := range []string{"metadata", "missing-directory", "missing-file", "directory"} {
		t.Run(mode, func(t *testing.T) {
			name, modified, identity := fixture.startup.Backup, fixture.attempt.BackupModifiedNS, fixture.attempt.BackupIdentity
			switch mode {
			case "metadata":
				modified = "not a timestamp"
			case "missing-directory":
				name = filepath.Join(t.TempDir(), "absent", "backup.raw")
			case "missing-file":
				name = filepath.Join(t.TempDir(), "absent.raw")
			case "directory":
				name = t.TempDir()
			}
			if _, err := backupObservation(name, fixture.attempt.BackupBytes, modified, identity); !errors.Is(err, ErrActivation) {
				t.Fatal("unconfirmed recovery archive was accepted", err)
			}
		})
	}
	file, err := os.Open(fixture.startup.Backup)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	if _, err := preparationFileIdentity(file); err == nil {
		t.Fatal("closed native file handle supplied a backup identity")
	}
	if _, _, _, err := readInstallation(config.Startup{DataDir: filepath.Join(t.TempDir(), "invalid\x00", "data")}); !errors.Is(err, ErrActivation) {
		t.Fatal("invalid installation path opted into manual compatibility", err)
	}
	manual := fixture.startup
	manual.Root = filepath.Join(fixture.root, "app")
	if err := os.Mkdir(manual.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := installationRoots(manual, fixture.root, fixture.attempt, true); !errors.Is(err, ErrActivation) {
		t.Fatal("an ordinary app directory replaced the verified app link", err)
	}
	if err := os.Rename(fixture.root, fixture.root+".retained"); err != nil {
		t.Fatal(err)
	}
	if _, err := installationRoots(fixture.startup, fixture.root, fixture.attempt, false); !errors.Is(err, ErrActivation) {
		t.Fatal("missing installation root retained ownership", err)
	}
}

func TestOfflinePreparationRefusesLostOfflineProofAndUnavailableStores(t *testing.T) {
	for _, mode := range []string{"offline-first", "offline-before-open", "busy", "state", "memory", "schedules"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newActivationFixture(t)
			fixture.bindBuild(t)
			failure := errors.New("isolated offline proof lost")
			if mode == "busy" {
				owner, err := ownership.Acquire(t.Context(), fixture.startup.DataDir)
				if err != nil {
					t.Fatal(err)
				}
				defer owner.Close()
			}
			if mode == "state" {
				if err := os.WriteFile(filepath.Join(fixture.startup.DataDir, "state.json"), []byte("invalid state"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "memory" || mode == "schedules" {
				if mode == "memory" {
					if err := os.WriteFile(filepath.Join(fixture.startup.DataDir, "memory"), []byte("unowned memory marker"), 0o600); err != nil {
						t.Fatal(err)
					}
				} else if err := os.MkdirAll(filepath.Join(fixture.startup.DataDir, "schedules", "schedules.sqlite"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			observations := 0
			err := prepareDataOffline(t.Context(), fixture.startup, func(context.Context) error {
				observations++
				if mode == "offline-first" && observations == 1 || mode == "offline-before-open" && observations == 2 {
					return failure
				}
				return nil
			})
			if err == nil {
				t.Fatal("unavailable preparation dependency published success")
			}
			if _, err := os.Lstat(filepath.Join(fixture.root, preparationFile)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("failed preparation published a bootable receipt", err)
			}
		})
	}
}

func TestPreparationArchiveRequiresTheSavedStateBeforeDatabaseWork(t *testing.T) {
	name := filepath.Join(t.TempDir(), "no-state.raw")
	file, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	archive := backups.ValidatedArchive{
		Directory: t.TempDir(),
		Manifest:  backups.Manifest{SchemaVersion: 1, CreatedAt: 1, AppVersion: "1.0.0", SourceID: "fixture"},
	}
	writeErr := backups.WriteArchive(t.Context(), file, archive)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		t.Fatal(writeErr, closeErr)
	}
	if _, err := authenticatePreparationBackup(t.Context(), name, true); !errors.Is(err, backups.ErrInvalid) {
		t.Fatal("archive without saved state authorized preparation", err)
	}
	if _, err := authenticatePreparationBackup(t.Context(), filepath.Join(t.TempDir(), "missing", "backup.raw"), false); err == nil {
		t.Fatal("unavailable archive parent authorized preparation")
	}
	processBuildFixture(t)
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := assembleService(cancelled, config.Startup{Role: config.RoleWorker, DataDir: t.TempDir()}, "isolated"); err == nil {
		t.Fatal("cancelled worker assembly continued to execution")
	}
	if err := runService(cancelled, config.Startup{}, "isolated", bytes.NewReader(nil), io.Discard, nil); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled startup reached its unavailable constructor", err)
	}
}
