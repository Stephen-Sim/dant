package platform

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const platformHelperArgument = "--dant-platform-process-fixture"

// Only the current isolated test executable runs as a child, never a host tool.
func TestPlatformProcessHelper(t *testing.T) {
	arguments := os.Args
	for len(arguments) > 0 && arguments[0] != platformHelperArgument {
		arguments = arguments[1:]
	}
	if len(arguments) < 2 {
		return
	}
	arguments = arguments[1:]

	switch arguments[0] {
	case "echo":
		_, _ = io.Copy(os.Stdout, os.Stdin)
		_, _ = io.WriteString(os.Stderr, "fixture-private-stderr")
	case "arguments":
		_ = json.NewEncoder(os.Stdout).Encode(arguments[1:])
	case "bytes":
		_, _ = io.WriteString(os.Stdout, strings.Repeat("x", 4096))
	case "failure":
		_, _ = io.WriteString(os.Stderr, "fixture-private-failure")
		os.Exit(17)
	case "wait":
		time.Sleep(time.Hour)
	default:
		os.Exit(18)
	}
	os.Exit(0)
}

func platformChild(t *testing.T, mode string, arguments ...string) (string, []string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return executable, append([]string{"-test.run=^TestPlatformProcessHelper$", "--", platformHelperArgument, mode}, arguments...)
}

func TestRunOwnsShellFreeInputOutputAndExactOutputLimits(t *testing.T) {
	executable, arguments := platformChild(t, "echo")
	wanted := "isolated fixture input\n"
	actual, err := Run(context.Background(), executable, arguments, strings.NewReader(wanted))
	if err != nil || string(actual) != wanted {
		t.Fatal("child input/output changed or private stderr was exposed", err)
	}

	literals := []string{"$(fixture-must-remain-text)", "two words", `a"b`, "first;second", "a&b", "<fixture>"}
	executable, arguments = platformChild(t, "arguments", literals...)
	actual, err = RunLimited(context.Background(), executable, arguments, nil, 4096)
	var received []string
	if err != nil || json.Unmarshal(actual, &received) != nil || !reflect.DeepEqual(received, literals) {
		t.Fatal("argument boundaries were changed or interpreted by a shell", err)
	}

	executable, arguments = platformChild(t, "bytes")
	actual, err = RunLimited(context.Background(), executable, arguments, nil, 4096)
	if err != nil || string(actual) != strings.Repeat("x", 4096) {
		t.Fatal("an exact-budget output was truncated", err)
	}
	actual, err = RunLimited(context.Background(), executable, arguments, nil, 4095)
	if !errors.Is(err, ErrCommandOutputLimit) || actual != nil {
		t.Fatal("oversized child output escaped its budget or exposed partial data", err)
	}
}

func TestRunRejectsInvalidLimitsAndClassifiesFailuresWithoutRawDiagnostics(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing-platform-fixture-executable")
	for _, limit := range []int{-1, 0, MaxCommandOutputLimit + 1} {
		actual, err := RunLimited(context.Background(), missing, nil, nil, limit)
		if !errors.Is(err, ErrCommandOutputLimit) || actual != nil {
			t.Fatal("an invalid output limit reached process execution", err)
		}
	}
	actual, err := RunLimited(context.Background(), missing, nil, nil, 32)
	if !errors.Is(err, ErrCommandFailed) || err.Error() != "host_command_failed" || actual != nil {
		t.Fatal("launch failure was not classified without its private path")
	}

	executable, arguments := platformChild(t, "failure")
	actual, err = Run(context.Background(), executable, arguments, nil)
	if !errors.Is(err, ErrCommandFailed) || err.Error() != "host_command_failed" || actual != nil {
		t.Fatal("a failed child exposed stderr or an unclassified exit status")
	}
}

type processInputSignal struct {
	once    sync.Once
	started chan struct{}
}

func (input *processInputSignal) Read([]byte) (int, error) {
	input.once.Do(func() { close(input.started) })
	return 0, io.EOF
}

func TestRunCancellationJoinsAnActuallyStartedChild(t *testing.T) {
	executable, arguments := platformChild(t, "wait")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	started := &processInputSignal{started: make(chan struct{})}
	result := make(chan error, 1)
	go func() {
		actual, err := Run(ctx, executable, arguments, started)
		if actual != nil {
			result <- errors.New("cancelled_child_returned_output")
			return
		}
		result <- err
	}()

	// os/exec begins copying a Reader only after successfully starting the child.
	select {
	case <-started.started:
	case err := <-result:
		t.Fatal("child exited before its input transport started", err)
	case <-time.After(10 * time.Second):
		t.Fatal("child input transport did not start")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("cancelled execution did not retain its context outcome", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled child was not joined")
	}
}

func waitPlatformProcess(t *testing.T, process *Process) {
	t.Helper()
	select {
	case <-process.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("owned child did not finish")
	}
}

func TestOwnedProcessReportsCompletionFailureAndCancellationWithoutReplay(t *testing.T) {
	for _, mode := range []string{"echo", "failure"} {
		t.Run(mode, func(t *testing.T) {
			executable, arguments := platformChild(t, mode)
			process, err := StartProcess(context.Background(), executable, arguments)
			if err != nil {
				t.Fatal("isolated child could not start", err)
			}
			t.Cleanup(process.Stop)
			waitPlatformProcess(t, process)
			if mode == "echo" && process.Err() != nil {
				t.Fatal("a successful child became an unknown failure", process.Err())
			}
			if mode == "failure" && !errors.Is(process.Err(), ErrCommandFailed) {
				t.Fatal("a child failure exposed an unclassified process error", process.Err())
			}
			process.Stop()
			process.Stop()
		})
	}

	executable, arguments := platformChild(t, "wait")
	for _, stopDirectly := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		process, err := StartProcess(ctx, executable, arguments)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		t.Cleanup(cancel)
		t.Cleanup(process.Stop)
		if stopDirectly {
			process.Stop()
		} else {
			cancel()
			waitPlatformProcess(t, process)
		}
		if !errors.Is(process.Err(), context.Canceled) {
			t.Fatal("owned shutdown lost its cancellation outcome", process.Err())
		}
	}
}

func TestOwnedProcessRejectsPrecancelledAndUnstartableCommands(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing-owned-fixture-executable")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	process, err := StartProcess(ctx, missing, nil)
	if process != nil || !errors.Is(err, context.Canceled) {
		t.Fatal("a pre-cancelled child was started")
	}
	process, err = StartProcess(context.Background(), missing, nil)
	if process != nil || !errors.Is(err, ErrCommandFailed) || err.Error() != "host_command_failed" {
		t.Fatal("an unstartable child exposed its path or a native process error")
	}
}
