package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/buildinfo"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestExecutorHandshakeUsesTheBuildVersionAndFixedPlatformToolSettings(t *testing.T) {
	previousVersion := buildinfo.Version
	buildinfo.Version = "3.2.1-beta.7"
	t.Cleanup(func() { buildinfo.Version = previousVersion })
	fixture := newRPCFixture(t)
	stopped := make(chan struct{})
	close(stopped)
	var process ProcessOptions
	worker, _ := workerFixture(t, WorkerOptions{Factory: func(_ context.Context, options ProcessOptions) (*Executor, error) {
		process = options
		return &Executor{RPC: fixture.client, Stopped: stopped}, nil
	}})
	done := make(chan error, 1)
	go func() {
		_, err := worker.Connect(context.Background())
		done <- err
	}()
	initialize := rpcMethod(t, fixture, "initialize")
	var params struct {
		ClientInfo   struct{ Name, Title, Version string }
		Capabilities struct{ ExperimentalAPI bool }
	}
	if json.Unmarshal(initialize["params"], &params) != nil || params.ClientInfo.Name != "dant" || params.ClientInfo.Title != "dant" || params.ClientInfo.Version != "3.2.1-beta.7" || !params.Capabilities.ExperimentalAPI {
		t.Fatal("initialize metadata lost its build provenance or negotiated capability")
	}
	settings := map[string]string{}
	for index, argument := range process.Args {
		if argument == "-c" && index+1 < len(process.Args) {
			key, value, present := strings.Cut(process.Args[index+1], "=")
			if !present || settings[key] != "" {
				t.Fatal("executor arguments contain malformed or duplicated tool settings")
			}
			settings[key] = value
		}
	}
	var python string
	var toolArgs []string
	if json.Unmarshal([]byte(settings["mcp_servers.dant_desktop.command"]), &python) != nil || python != "/usr/bin/python3" || settings["mcp_servers.dant_desktop.tool_timeout_sec"] != "660" || len(settings) != 5 {
		t.Fatal("fixed VM adapter settings changed their executable or timeout units")
	}
	if json.Unmarshal([]byte(settings["mcp_servers.dant_desktop.args"]), &toolArgs) != nil || len(toolArgs) != 3 || toolArgs[0] != filepath.Join(worker.options.Home, "dant", "vm", "desktop_mcp.py") || toolArgs[1] != "--output-dir" || toolArgs[2] != filepath.Join(worker.WorkspaceRoot(), "captured-conversation", "output") {
		t.Fatal("MCP helper escaped the captured VM installation or conversation output directory")
	}
	replyFixture(t, fixture, initialize, `{}`)
	rpcMethod(t, fixture, "initialized")
	replyFixture(t, fixture, rpcMethod(t, fixture, "account/read"), `{"account":null}`)
	replyFixture(t, fixture, rpcMethod(t, fixture, "model/list"), `{"data":[]}`)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestGuestValidationAndMaintenanceScreenUseTheCanonicalLoopbackProtocol(t *testing.T) {
	protocol := config.DefaultProtocol()
	for _, host := range protocol.LoopbackHosts {
		if err := ValidateGuestOrigin("http://" + host + ":4320/"); err != nil {
			t.Fatal("canonical loopback host was refused", err)
		}
	}
	for _, origin := range []string{
		"https://127.0.0.1:4320", "http://example.invalid:4320", "http://127.0.0.1:4320/other",
		"http://user@localhost:4320", "http://localhost:4320?query=1", "http://localhost:4320#fragment", "not-an-origin",
	} {
		if err := ValidateGuestOrigin(origin); !errors.Is(err, ErrVMUnavailable) {
			t.Fatal("guest origin bypassed canonical scheme, host or path restrictions", err)
		}
	}
	requests := []string{}
	worker, _ := workerFixture(t, WorkerOptions{Client: probeClient(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.URL.Path)
		if request.Method != http.MethodGet {
			t.Fatal("offline screen observation performed a guest mutation")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("synthetic screen"))}, nil
	})})
	response, err := worker.Guest(t.Context(), protocol.Paths.Screen, nil)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	for _, route := range []string{protocol.Paths.Input, protocol.Paths.Control, protocol.Paths.File, protocol.Paths.ReadFile} {
		if _, err := worker.Guest(t.Context(), route, json.RawMessage(`{}`)); !errors.Is(err, ErrDisconnected) {
			t.Fatal("offline guest bridge allowed a mutation", err)
		}
	}
	worker.mu.Lock()
	worker.status = contracts.ConnectionStatusOnline
	worker.mu.Unlock()
	if _, err := worker.Guest(t.Context(), protocol.Paths.Screen+"?unvalidated=1", nil); !errors.Is(err, ErrInvalidProtocol) || len(requests) != 1 || requests[0] != protocol.Paths.Screen {
		t.Fatal("guest allowlist accepted query-bearing or unrecognized paths", err)
	}
}
