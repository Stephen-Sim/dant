package backups

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/files"
	"golang.org/x/sys/windows"
)

func holdBackupFixtureFile(t *testing.T, name string, sharing uint32) {
	t.Helper()
	encoded, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(encoded, windows.GENERIC_READ, sharing, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal("isolated backup fixture could not be held", err)
	}
	t.Cleanup(func() {
		if err := windows.CloseHandle(handle); err != nil {
			t.Error(err)
		}
	})
}

func TestWindowsWorkerCaptureRejectsAReadLockedStateWithoutLeakingAStage(t *testing.T) {
	options := workerSnapshotFixture(t)
	name := filepath.Join(options.DataDir, "state.json")
	before, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("state read unavailable", func(t *testing.T) {
		holdBackupFixtureFile(t, name, 0)
		if backup, err := CreateWorkerBackup(t.Context(), options); !errors.Is(err, ErrInvalid) || backup != nil {
			t.Fatal("read-locked conversation was accepted for capture", err)
		}
		assertSnapshotStagesEmpty(t, options.TemporaryRoot)
	})
	if after, err := os.ReadFile(name); err != nil || !bytes.Equal(after, before) {
		t.Fatal("failed capture changed the original state", err)
	}
}

func TestWindowsRestoreRetainsOldOwnerEvidenceWhenItsRemovalIsLocked(t *testing.T) {
	root, data := restoredStateFixture(t)
	owner := filepath.Join(data, ".dant-core-owner.lock")
	if err := os.WriteFile(owner, []byte("old synthetic owner"), 0600); err != nil {
		t.Fatal(err)
	}
	holdBackupFixtureFile(t, owner, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE)
	if err := PrepareRestoredWorkerState(t.Context(), root); !errors.Is(err, ErrInvalid) {
		t.Fatal("restore preparation ignored the unretired owner file", err)
	}
	if raw, err := os.ReadFile(filepath.Join(data, "state.json")); err != nil || string(raw) != cliFixtureState {
		t.Fatal("failed owner retirement partially rewrote the conversation", err)
	}
}

func TestWindowsCapturedSourceVersionRejectsAnOrdinaryReplacementBeforeRecordingIt(t *testing.T) {
	capture, source := captureBoundaryFixture(t)
	name := filepath.Join(source, "original")
	if err := os.WriteFile(name, []byte("original bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	identity, err := files.CaptureIdentity(name)
	if err != nil {
		t.Fatal(err)
	}
	retained := name + "-retained"
	if err := os.Rename(name, retained); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("replacement bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := capture.observe(name, identity); !errors.Is(err, ErrSourceChanged) || len(capture.observed) != 0 {
		t.Fatal("a replacement acquired the captured source identity", err)
	}
	if raw, err := os.ReadFile(retained); err != nil || string(raw) != "original bytes" {
		t.Fatal("rejected metadata comparison removed the original source", err)
	}
}

func TestWindowsJournalCleanupCannotRemoveReadOnlyOwnedEvidence(t *testing.T) {
	for _, temporary := range []bool{false, true} {
		name := filepath.Join(t.TempDir(), "journal.json")
		file := name
		if temporary {
			file += ".tmp"
		}
		if err := os.WriteFile(file, []byte("retained journal bytes"), 0600); err != nil {
			t.Fatal(err)
		}
		t.Run(map[bool]string{false: "journal", true: "temporary journal"}[temporary], func(t *testing.T) {
			holdBackupFixtureFile(t, file, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE)
			var err error
			if temporary {
				err = discardJournalTemporary(name)
			} else {
				err = clearJournal(name)
			}
			if !errors.Is(err, ErrRestoreFailed) {
				t.Fatal("failed evidence cleanup was acknowledged as complete", err)
			}
			if raw, err := os.ReadFile(file); err != nil || string(raw) != "retained journal bytes" {
				t.Fatal("failed cleanup rewrote the retained evidence", err)
			}
		})
	}
}

func TestWindowsPrivateRestoreCopiesAndFlushesRejectLockedSourceFiles(t *testing.T) {
	for _, flush := range []bool{false, true} {
		t.Run(map[bool]string{false: "copy", true: "flush"}[flush], func(t *testing.T) {
			source := t.TempDir()
			name := filepath.Join(source, "retained.bin")
			if err := os.WriteFile(name, []byte("original private bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			holdBackupFixtureFile(t, name, 0)
			var err error
			if flush {
				err = flushRestoreTree(t.Context(), source)
			} else {
				err = copyRestoreTree(t.Context(), source, filepath.Join(t.TempDir(), "copy"))
			}
			if err == nil {
				t.Fatal("locked restore input was acknowledged as copied or durable")
			}
		})
	}
}

func TestWindowsRestoreCannotClearLockedRejectionEvidenceOrConsumeAnotherArchive(t *testing.T) {
	options := restoreFixture(t)
	locations, err := restoreLocations(options)
	if err != nil {
		t.Fatal(err)
	}
	before := []byte(`{"rejected":true,"restoreId":"` + options.RestoreID + `"}`)
	if err := os.WriteFile(locations.rejection, before, 0600); err != nil {
		t.Fatal(err)
	}
	holdBackupFixtureFile(t, locations.rejection, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE)
	reader := &restoreReadCounter{}
	if receipt, err := RestoreWorkerBackup(t.Context(), options, reader); !errors.Is(err, ErrRestoreFailed) || receipt.Restored || reader.reads != 0 {
		t.Fatal("unretired rejection evidence permitted another archive consumption", err)
	}
	if raw, err := os.ReadFile(locations.rejection); err != nil || !bytes.Equal(raw, before) {
		t.Fatal("failed rejection retirement rewrote the old evidence", err)
	}
	assertOriginalRestoreRoots(t, options)
}

func TestWindowsBackupIdentityAndKernelLocksRejectMissingOrContendedOwnedFiles(t *testing.T) {
	name := filepath.Join(t.TempDir(), "kernel")
	if _, err := directoryIdentity(name); !errors.Is(err, ErrInvalid) {
		t.Fatal("missing path acquired an invented filesystem identity", err)
	}
	first, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if err := kernelLock(first); err != nil {
		t.Fatal(err)
	}
	second, err := os.OpenFile(name, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if err := kernelLock(second); !errors.Is(err, ErrBusy) {
		t.Fatal("a second handle acquired an already owned restoration lease", err)
	}
	info, err := files.CaptureIdentity(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sourceVersion(name+"-missing", info); err == nil {
		t.Fatal("a missing source path acquired another file's version")
	}
}
