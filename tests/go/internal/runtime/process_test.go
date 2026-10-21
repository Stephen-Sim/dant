package runtime

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestExecutorFixtureProcess(t *testing.T) {
	if len(os.Args) < 2 || os.Args[len(os.Args)-1] != "--isolated-rpc-fixture" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID json.RawMessage `json:"id"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(8)
		}
		_, _ = fmt.Fprintf(os.Stdout, "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"fixture\":true}}\n", request.ID)
		os.Exit(0)
	}
	os.Exit(0)
}

func TestSpawnExecutorOwnsPipesAndJoinsAnIsolatedRPCProcess(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executor, err := SpawnExecutor(t.Context(), ProcessOptions{Command: executable, Args: []string{"-test.run=^TestExecutorFixtureProcess$", "--", "--isolated-rpc-fixture"}, Directory: t.TempDir(), Environment: os.Environ()})
	if err != nil {
		t.Fatal(err)
	}
	result, err := executor.RPC.Request(t.Context(), "fixture/echo", contracts.RawObject{})
	if err != nil || string(result["fixture"]) != "true" {
		t.Fatal("owned process RPC did not preserve its response", result, err)
	}
	select {
	case <-executor.Stopped:
	case <-time.After(10 * time.Second):
		t.Fatal("executor child was not joined")
	}
	_ = executor.Stop()
	if err := executor.Stop(); err != nil {
		t.Fatal("idempotent stop repeated a signal", err)
	}
	if _, err := executor.RPC.Request(t.Context(), "fixture/again", contracts.RawObject{}); !errors.Is(err, ErrDisconnected) {
		t.Fatal("exited executor remained connected", err)
	}
}

func TestSpawnExecutorRejectsMissingExecutableAndWorkingDirectory(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, options := range []ProcessOptions{{Command: filepath.Join(t.TempDir(), "missing-executor")}, {Command: executable, Directory: filepath.Join(t.TempDir(), "missing-directory")}} {
		if _, err := SpawnExecutor(t.Context(), options); !errors.Is(err, ErrDisconnected) {
			t.Fatal("process launch failure exposed an unclassified error", err)
		}
	}
}
