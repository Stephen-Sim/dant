package backups

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func offlineFixture(t *testing.T) offlineInspection {
	t.Helper()
	root := t.TempDir()
	proc := filepath.Join(root, "proc")
	if err := os.Mkdir(proc, 0700); err != nil {
		t.Fatal(err)
	}
	return offlineInspection{
		home: root, data: filepath.Join(root, "data"), proc: proc, uid: 1000,
		running: func(context.Context) (bool, error) { return false, nil },
	}
}

func writeOfflineProcess(t *testing.T, options offlineInspection, name, command string, uid int, environment string) {
	t.Helper()
	root := filepath.Join(options.proc, name)
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	stat := []string{"S"}
	for range 19 {
		stat = append(stat, "0")
	}
	stat[19] = "1234"
	for file, data := range map[string]string{
		"status":  "Name:\tfixture\nUid:\t" + strings.Repeat(strconv.Itoa(uid)+"\t", 4) + "\n",
		"cmdline": command + "\x00fixture-argument\x00",
		"stat":    name + " (isolated fixture) " + strings.Join(stat, " "),
		"environ": environment,
	} {
		if err := os.WriteFile(filepath.Join(root, file), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOfflineProofRejectsLiveOwnedNodeCodexAndCoreButPreservesUnrelatedApps(t *testing.T) {
	for _, command := range []string{"/usr/bin/node", "/usr/bin/nodejs", "/vendor/codex/codex", "/home/dant/dant/bin/dant-core"} {
		t.Run(filepath.Base(command), func(t *testing.T) {
			options := offlineFixture(t)
			writeOfflineProcess(t, options, "17", command, 1000, "CODEX_HOME="+filepath.Join(options.home, ".dant-codex")+"\x00")
			if err := inspectWorkerOffline(t.Context(), options); !errors.Is(err, ErrBusy) {
				t.Fatal("live owned executor was accepted", err)
			}
		})
	}
	options := offlineFixture(t)
	writeOfflineProcess(t, options, "17", "/usr/bin/node", 1000, "DANT_DATA="+options.data+"\x00")
	if err := inspectWorkerOffline(t.Context(), options); !errors.Is(err, ErrBusy) {
		t.Fatal("live legacy Worker with exact data directory was accepted", err)
	}
	options.selfPID = 17
	if err := inspectWorkerOffline(t.Context(), options); err != nil {
		t.Fatal("the exact inspecting maintenance process was treated as an executor", err)
	}

	unrelated := offlineFixture(t)
	writeOfflineProcess(t, unrelated, "18", "/usr/bin/firefox", 1000, "CODEX_HOME="+filepath.Join(unrelated.home, ".dant-codex")+"\x00")
	writeOfflineProcess(t, unrelated, "19", "/usr/bin/codex", 1000, "CODEX_HOME="+filepath.Join(unrelated.home, ".codex")+"\x00")
	writeOfflineProcess(t, unrelated, "20", "/usr/bin/codex", 2000, "DANT_DATA="+unrelated.data+"\x00")
	if err := inspectWorkerOffline(t.Context(), unrelated); err != nil {
		t.Fatal("unrelated browser or Codex session was treated as the Worker", err)
	}
}

func TestOfflineProofChecksServiceTwiceAndRetainsUnconfirmedOrCancelledResult(t *testing.T) {
	for _, test := range []struct {
		name string
		run  func(context.Context) (bool, error)
	}{
		{"active", func(context.Context) (bool, error) { return true, nil }},
		{"unknown", func(context.Context) (bool, error) { return false, errors.New("private service result") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			options := offlineFixture(t)
			options.running = test.run
			if err := inspectWorkerOffline(t.Context(), options); !errors.Is(err, ErrBusy) {
				t.Fatal(err)
			}
		})
	}
	options := offlineFixture(t)
	calls := 0
	options.running = func(context.Context) (bool, error) {
		calls++
		return calls > 1, nil
	}
	if err := inspectWorkerOffline(t.Context(), options); !errors.Is(err, ErrBusy) || calls != 2 {
		t.Fatal("replacement service became active without invalidating proof", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := inspectWorkerOffline(cancelled, offlineFixture(t)); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestOfflineProofRejectsUnreadableOversizedOrMalformedOwnedProcess(t *testing.T) {
	for _, test := range []struct{ field, data string }{
		{"status", "Uid:\tnot-a-number\n"},
		{"stat", "malformed"},
		{"environ", strings.Repeat("x", processEnvironmentLimit+1)},
	} {
		t.Run(test.field, func(t *testing.T) {
			options := offlineFixture(t)
			writeOfflineProcess(t, options, "17", "/usr/bin/codex", 1000, "CODEX_HOME="+filepath.Join(options.home, ".dant-codex")+"\x00")
			if err := os.WriteFile(filepath.Join(options.proc, "17", test.field), []byte(test.data), 0600); err != nil {
				t.Fatal(err)
			}
			if err := inspectWorkerOffline(t.Context(), options); !errors.Is(err, ErrBusy) {
				t.Fatal(err)
			}
		})
	}
}
