package backups

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOfflineInspectionRejectsUnavailableRootsAndInvalidOwnership(t *testing.T) {
	for _, mode := range []string{"home", "data", "uid", "service", "missing-proc", "proc-file"} {
		t.Run(mode, func(t *testing.T) {
			options := offlineFixture(t)
			switch mode {
			case "home":
				options.home = "relative"
			case "data":
				options.data = "relative"
			case "uid":
				options.uid = 0
			case "service":
				options.running = nil
			case "missing-proc":
				options.proc += "-missing"
			case "proc-file":
				options.proc = filepath.Join(t.TempDir(), "not-a-proc-directory")
				if err := os.WriteFile(options.proc, []byte("retained"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := inspectWorkerOffline(t.Context(), options); !errors.Is(err, ErrBusy) {
				t.Fatal("unavailable ownership evidence became an offline proof", err)
			}
		})
	}
}

func TestOfflineInspectionIgnoresNonProcessNamesAndVanishedProcesses(t *testing.T) {
	options := offlineFixture(t)
	for _, name := range []string{"0", "01", "net", "4294967296", "77"} {
		if err := os.Mkdir(filepath.Join(options.proc, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := inspectWorkerOffline(t.Context(), options); err != nil {
		t.Fatal("non-PID entries or an already exited process blocked an offline proof", err)
	}
	for _, raw := range []string{"Name:\tfixture\n", "Uid:\t1 2 3 4 5", "Uid:\t4294967296 1 1 1"} {
		if _, err := processUID([]byte(raw)); !errors.Is(err, ErrBusy) {
			t.Fatal("malformed process ownership was accepted", err)
		}
	}
	for _, raw := range []string{"17 (unfinished", "17 (fixture) S 1", "17 (fixture) " + strings.Repeat("S ", 20)} {
		if _, err := processStart([]byte(raw), "17"); !errors.Is(err, ErrBusy) {
			t.Fatal("missing or invalid process generation was accepted", err)
		}
	}
}

func TestOfflineProcessReadersPreserveMissingOversizedAndCancelledEvidence(t *testing.T) {
	for _, field := range []string{"cmdline", "stat", "environ"} {
		t.Run(field, func(t *testing.T) {
			options := offlineFixture(t)
			writeOfflineProcess(t, options, "17", "/usr/bin/codex", options.uid, "DANT_DATA="+options.data+"\x00")
			if err := os.Remove(filepath.Join(options.proc, "17", field)); err != nil {
				t.Fatal(err)
			}
			root, err := os.OpenRoot(options.proc)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			if owned, err := ownedExecutorProcess(t.Context(), root, "17", options); !errors.Is(err, os.ErrNotExist) || owned {
				t.Fatal("vanished process field invented a confirmed executor", err)
			}
		})
	}
	options := offlineFixture(t)
	root, err := os.OpenRoot(options.proc)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if raw, err := readProcessFile(ctx, root, "missing", processStatusLimit); !errors.Is(err, context.Canceled) || raw != nil {
		t.Fatal("cancelled process inspection attempted a filesystem read", err)
	}
	if err := os.WriteFile(filepath.Join(options.proc, "oversized"), []byte("12345"), 0600); err != nil {
		t.Fatal(err)
	}
	if raw, err := readProcessFile(t.Context(), root, "oversized", 4); !errors.Is(err, ErrBusy) || raw != nil {
		t.Fatal("oversized process output escaped the bounded reader", err)
	}
}

func TestOfflineCancellationStopsDuringScanningAndAfterAProcessRead(t *testing.T) {
	for _, remaining := range []int{3, 4, 6} {
		options := offlineFixture(t)
		writeOfflineProcess(t, options, "17", "/usr/bin/codex", options.uid, "DANT_DATA="+options.data+"\x00")
		ctx, cancel := context.WithCancel(t.Context())
		counted := &preflightCheckCancellation{Context: ctx, cancel: cancel, remaining: remaining}
		err := inspectWorkerOffline(counted, options)
		cancel()
		if !errors.Is(err, context.Canceled) {
			t.Fatal("mid-inspection cancellation became a successful or busy proof", err)
		}
	}
	options := offlineFixture(t)
	writeOfflineProcess(t, options, "17", "/usr/bin/codex", options.uid, "DANT_DATA="+options.data+"\x00")
	root, err := os.OpenRoot(options.proc)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, remaining := range []int{2, 5, 9} {
		ctx, cancel := context.WithCancel(t.Context())
		counted := &preflightCheckCancellation{Context: ctx, cancel: cancel, remaining: remaining}
		owned, err := ownedExecutorProcess(counted, root, "17", options)
		cancel()
		if !errors.Is(err, context.Canceled) || owned {
			t.Fatal("process read cancellation leaked a confirmed executor identity", err)
		}
	}
}
