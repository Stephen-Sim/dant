package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestControllerReconnectPreservesOnlineWorkerAndUnknownDeploymentFence(t *testing.T) {
	for _, priorTarget := range []bool{false, true} {
		name := "current target"
		if priorTarget {
			name = "prior target"
		}
		t.Run(name, func(t *testing.T) {
			app, bridge, power, token := controllerOperationsFixture(t)
			if err := os.WriteFile(filepath.Join(app.options.DataDir, "fixture.key"), []byte("isolated key"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(app.options.DataDir, "vm.json"), []byte(`{"host":"fixture.invalid","user":"fixture","keyPath":"fixture.key"}`), 0600); err != nil {
				t.Fatal(err)
			}
			binding, err := computer.ReadBinding(app.options.DataDir)
			if err != nil {
				t.Fatal(err)
			}

			paths := []string{
				computer.GuestBinaryPath, "vm/install-worker.sh", "vm/worker-install.py",
				"vm/guest.py", "vm/control.py", "vm/desktop.py", "vm/desktop_mcp.py",
				"vm/start-codex.sh", "vm/transcribe_audio.py", "vm/voice_message.py",
				config.ProtocolResourcePath,
			}
			sort.Strings(paths)
			manifest := computer.BundleManifest{
				SchemaVersion: 1,
				Version:       app.options.Version,
				SourceCommit:  app.options.BuildSource,
			}
			for _, path := range paths {
				manifest.Files = append(manifest.Files, computer.BundleFile{
					Path:   path,
					Bytes:  1,
					SHA256: strings.Repeat("a", 64),
				})
			}
			manifestRaw, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			manifestPath := filepath.Join(app.options.Root, filepath.FromSlash(computer.BundleManifestPath))
			if err := os.MkdirAll(filepath.Dir(manifestPath), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(manifestPath, manifestRaw, 0600); err != nil {
				t.Fatal(err)
			}
			fingerprint := sha256.Sum256(manifestRaw)
			pendingSource := hex.EncodeToString(fingerprint[:])
			if priorTarget {
				pendingSource = strings.Repeat("c", 64)
			}
			fence := []byte(`{"schemaVersion":1,"entries":[{"binding":"` + computer.BindingDigest(binding) + `","source":"` + pendingSource + `"}]}`)
			fencePath := filepath.Join(app.options.DataDir, "vm-update-attempts.json")
			if err := os.WriteFile(fencePath, fence, 0600); err != nil {
				t.Fatal(err)
			}

			observations, installs := 0, 0
			deployer, err := computer.NewDeployer(computer.DeploymentOptions{
				Context:     t.Context(),
				ProjectRoot: app.options.Root,
				DataDir:     app.options.DataDir,
				Version:     manifest.Version,
				BuildSource: manifest.SourceCommit,
				Run: func(_ context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
					if input != nil {
						installs++
						return nil, io.ErrUnexpectedEOF
					}
					observations++
					return []byte(`{"sha256":"` + strings.Repeat("b", 64) +
						`","active":true,"version":"0.4.7-beta.11",` +
						`"session":{"product":"dant","mode":"worker","runtime":"go","protocol":1,` +
						`"version":"0.4.7-beta.11","source":"` + strings.Repeat("b", 40) + `"}}`), nil
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			app.deployer = deployer
			bridge.mu.Lock()
			bridge.status = contracts.ConnectionStatusOnline
			bridge.state = controllerQuiescentState(contracts.ConnectionStatusOnline)
			bridge.mu.Unlock()
			bridge.connectOperation = func(ctx context.Context, deploy bool) error {
				if !deploy {
					t.Fatal("an online worker was unnecessarily reconnected")
				}
				return deployer.Prepare(ctx, binding)
			}

			for attempt := 1; attempt <= 2; attempt++ {
				response := controllerRecordedRequest(t, app, token, "POST", "/api/connect", `{}`)
				assertControllerCode(t, response, 409, "vm_update_unconfirmed")
				if !strings.Contains(response.Body.String(), "Automatic retry is blocked") {
					t.Fatal("an unknown upgrade returned only a generic connection failure")
				}
				retained, err := os.ReadFile(fencePath)
				if err != nil || !bytes.Equal(retained, fence) {
					t.Fatal("reconnect changed the unknown deployment fence", err)
				}
				if bridge.Status() != contracts.ConnectionStatusOnline || bridge.Generation() != 0 ||
					installs != 0 || observations != attempt || power.resumed != 0 || power.suspended != 0 {
					t.Fatal("an unknown upgrade disconnected the worker or redispatched installation")
				}
				status := deployer.Status()
				if status.Status != contracts.ServiceUpdateStatusPending || status.Confirmed ||
					status.Reason == nil || *status.Reason != "update-unconfirmed" || app.connectionPending || app.manual {
					t.Fatal("reconnect lost update uncertainty or retained request admission")
				}
			}

			if err := app.diagnostics.Close(); err != nil {
				t.Fatal(err)
			}
			records, err := app.diagnostics.Recent(t.Context(), 20)
			if err != nil {
				t.Fatal(err)
			}
			failures := 0
			for _, record := range records {
				if record.Event != "computer.update.unconfirmed" {
					continue
				}
				failures++
				if record.Code != codeVMUpdateUnconfirmed || record.Route != computerConnectRoute || record.Method != http.MethodPost {
					t.Fatal("the pending update lost its fixed operational diagnostic")
				}
			}
			if failures != 2 {
				t.Fatal("reconnect did not record each unconfirmed outcome", failures)
			}
		})
	}
}

func TestControllerUnknownUpgradeDiagnosticsAcceptOnlyFixedPostRoutes(t *testing.T) {
	app, _, _, _ := controllerAppFixture(t)
	private := "synthetic-private-token private-host.invalid private-request-content"
	for _, fixture := range []struct {
		method string
		route  string
		err    error
	}{
		{http.MethodPost, computerConnectRoute, computer.ErrDeploymentUnconfirmed},
		{http.MethodPost, computerUpdateRoute, computer.ErrDeploymentUnconfirmed},
		{http.MethodGet, computerConnectRoute, computer.ErrDeploymentUnconfirmed},
		{http.MethodPost, computerConnectRoute + "/private-host.invalid", computer.ErrDeploymentUnconfirmed},
		{http.MethodPost, computerUpdateRoute, errors.New(private)},
	} {
		request := httptest.NewRequest(fixture.method, "http://127.0.0.1:4317"+fixture.route+"?private=synthetic-private-token", strings.NewReader(private))
		app.writeRequestError(httptest.NewRecorder(), request, fmt.Errorf("%s: %w", private, fixture.err))
	}
	if err := app.diagnostics.Close(); err != nil {
		t.Fatal(err)
	}
	records, err := app.diagnostics.Recent(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	failures := 0
	for _, record := range records {
		if record.Event != "computer.update.unconfirmed" {
			continue
		}
		failures++
		if record.Code != codeVMUpdateUnconfirmed || record.Method != http.MethodPost ||
			(record.Route != computerConnectRoute && record.Route != computerUpdateRoute) {
			t.Fatal("an unconfirmed update diagnostic used an unapproved method, route or code")
		}
		raw, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range strings.Fields(private) {
			if bytes.Contains(raw, []byte(value)) {
				t.Fatal("operational diagnostics copied private request or error content")
			}
		}
	}
	if failures != 2 {
		t.Fatal("unconfirmed update diagnostics escaped their fixed route boundary", failures)
	}
}
