package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/controller"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/platform"
	"github.com/Stephen-Sim/dant/core/internal/skills"
)

type skillHTTPBridge struct {
	origin, token string
	client        *http.Client
	requests      atomic.Int32
}

func (*skillHTTPBridge) Status() contracts.ConnectionStatus { return contracts.ConnectionStatusOnline }
func (*skillHTTPBridge) Generation() uint64                 { return 1 }
func (*skillHTTPBridge) Snapshot() contracts.WorkerSnapshot {
	return contracts.WorkerSnapshot{Messages: []*contracts.ChatMessage{}, Completions: []contracts.Completion{}, WorkTasks: []contracts.WorkRecord{}, Queue: []string{}, Worker: contracts.WorkerState{Status: contracts.ConnectionStatusOnline}, Settings: contracts.Settings{Language: "zh"}}
}
func (bridge *skillHTTPBridge) Refresh(context.Context) (contracts.WorkerSnapshot, error) {
	return bridge.Snapshot(), nil
}
func (*skillHTTPBridge) Connect(context.Context, bool) error              { return nil }
func (*skillHTTPBridge) Prepare(context.Context) error                    { return nil }
func (*skillHTTPBridge) PauseWorkForUpdate(context.Context, string) error { return nil }
func (*skillHTTPBridge) Disconnect()                                      {}
func (*skillHTTPBridge) Close()                                           {}
func (bridge *skillHTTPBridge) Request(ctx context.Context, method, route string, headers http.Header, body io.Reader) (*http.Response, error) {
	bridge.requests.Add(1)
	request, err := http.NewRequestWithContext(ctx, method, bridge.origin+route, body)
	if err != nil {
		return nil, err
	}
	for key, values := range headers {
		request.Header[key] = append([]string{}, values...)
	}
	request.Header.Set("X-Dant-Token", bridge.token)
	return bridge.client.Do(request)
}

type skillTransportFixture struct {
	worker                                   *WorkerApp
	bridge                                   *skillHTTPBridge
	origin, token, workerOrigin, workerToken string
	client                                   *http.Client
}

func newSkillTransportFixture(t *testing.T) skillTransportFixture {
	t.Helper()
	worker := fixtureWorker(t)
	// The real skill/file routes and request/auth guards run over TCP. Readiness
	// alone is injected so export never starts a Codex process or model session.
	mux := http.NewServeMux()
	skills.RegisterRoutes(mux, skills.RouteOptions{Library: worker.skills, Importer: worker.skillImporter, Attachments: worker.attachments, Online: func() bool { return true }, Reload: func(context.Context) { worker.engine.InvalidateContext() }})
	registerFileRoutes(mux, worker.attachments, nil)
	workerServer := httptest.NewServer(worker.guardRequests(worker.auth.Middleware(mux, nil)))
	bridge := &skillHTTPBridge{origin: workerServer.URL, token: worker.auth.Info().Token, client: workerServer.Client()}
	root := t.TempDir()
	data := filepath.Join(root, "controller")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	host, err := platform.New("linux", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := computer.NewProfiles(computer.ProfileOptions{DataDir: data, ProjectRoot: root, RegistryFile: filepath.Join(root, "profiles.json"), Owner: "isolated-owner"})
	if err != nil {
		t.Fatal(err)
	}
	control, err := controller.New(t.Context(), controller.Options{Root: root, DataDir: data, Version: "0.4.7-beta.15", BuildSource: strings.Repeat("a", 40), Host: host, Profiles: profiles, PrepareOnly: true, BridgeFactory: func(computer.BridgeOptions) (controller.Bridge, error) { return bridge, nil }})
	if err != nil {
		workerServer.Close()
		t.Fatal(err)
	}
	server := httptest.NewServer(control.Handler())
	t.Cleanup(func() { control.Close(); server.Close(); workerServer.Close() })
	response, err := server.Client().Get(server.URL + "/api/session")
	if err != nil {
		t.Fatal(err)
	}
	var session struct{ Token string }
	if json.NewDecoder(response.Body).Decode(&session) != nil || session.Token == "" {
		response.Body.Close()
		t.Fatal("isolated Controller session unavailable")
	}
	response.Body.Close()
	return skillTransportFixture{worker: worker, bridge: bridge, origin: server.URL, token: session.Token, workerOrigin: workerServer.URL, workerToken: worker.auth.Info().Token, client: server.Client()}
}

func (fixture skillTransportFixture) request(t *testing.T, method, route string, body []byte) (*http.Response, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, fixture.origin+route, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Dant-Token", fixture.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := fixture.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, files.MaxAttachmentBytes+1))
	if err != nil || len(raw) > files.MaxAttachmentBytes {
		t.Fatal("isolated HTTP response exceeded bounded attachment transport", err)
	}
	return response, raw
}

func TestSkillHTTPMaximumEscapedEditorAndLargeAssetsPreserveBytesAcrossControllerAndWorker(t *testing.T) {
	fixture := newSkillTransportFixture(t)
	input := skills.SaveInput{Name: "maximum-wire-skill", Description: "Maximum raw text with quotes and backslashes.", Instructions: "i", Files: map[string]string{}}
	for index := range 4 {
		length := skills.EditorFileBytes
		if index == 3 {
			length--
		}
		input.Files["assets/"+string(rune('0'+index))+".txt"] = (strings.Repeat("a", 512) + strings.Repeat("\"\\", skills.EditorFileBytes/2))[:length]
	}
	wire, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(wire) < 2*1024*1024-4096 || len(wire) > config.APIJSONBodyBytes {
		t.Fatal("fixture did not exercise near-maximum encoded editor request")
	}
	response, raw := fixture.request(t, "POST", "/api/skills", wire)
	var view skills.View
	if response.StatusCode != 200 || json.Unmarshal(raw, &view) != nil || !reflect.DeepEqual(view.Files, input.Files) {
		t.Fatal("maximum escaped editor POST changed content")
	}
	large := map[string][]byte{"assets/reference.png": bytes.Repeat([]byte{0x89}, 1557774), "references/large.md": []byte(strings.Repeat("Large reference text.\n", 75000))}
	want := map[string][32]byte{}
	for relative, data := range large {
		target := filepath.Join(filepath.Dir(view.Path), filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0600); err != nil {
			t.Fatal(err)
		}
		want[relative] = sha256.Sum256(data)
	}
	response, raw = fixture.request(t, "GET", "/api/skills/"+input.Name, nil)
	if response.StatusCode != 200 || json.Unmarshal(raw, &view) != nil || !reflect.DeepEqual(view.Files, input.Files) || len(view.Assets) != 2 || len(raw) >= config.APIJSONBodyBytes {
		t.Fatal("large asset projection exceeded JSON transport or truncated editable files")
	}
	var fields contracts.RawObject
	if json.Unmarshal(raw, &fields) != nil || fields["binaryFiles"] != nil {
		t.Fatal("read-only asset bytes leaked into the editor JSON response")
	}
	patch, _ := json.Marshal(struct {
		Description  string            `json:"description"`
		Instructions string            `json:"instructions"`
		Files        map[string]string `json:"files"`
		Preserve     bool              `json:"preserveBinaryFiles"`
	}{"Edited without truncation.", "i", input.Files, true})
	response, raw = fixture.request(t, "PATCH", "/api/skills/"+input.Name, patch)
	if response.StatusCode != 200 || json.Unmarshal(raw, &view) != nil || !reflect.DeepEqual(view.Files, input.Files) {
		t.Fatal("large editor PATCH did not survive Controller/Worker JSON transport")
	}
	for relative, hash := range want {
		data, err := os.ReadFile(filepath.Join(filepath.Dir(view.Path), filepath.FromSlash(relative)))
		if err != nil || sha256.Sum256(data) != hash {
			t.Fatal("large read-only PNG/UTF8 bytes changed during metadata edit")
		}
	}
	state, err := fixture.worker.Snapshot(t.Context())
	if err != nil || len(state.Messages) != 0 || state.Active != nil || len(state.WorkTasks) != 0 {
		t.Fatal("skill management created agent work")
	}
}

func TestSkillHTTPControlEscapingAndOversizeBodiesAreBoundedBeforeForwarding(t *testing.T) {
	fixture := newSkillTransportFixture(t)
	input := skills.SaveInput{Name: "control-wire-skill", Description: "Control escaping boundary", Instructions: "i", Files: map[string]string{"assets/control.txt": strings.Repeat("\x01", 400000)}}
	wire, _ := json.Marshal(input)
	if len(wire) < 6*len(input.Files["assets/control.txt"]) || len(wire) > config.APIJSONBodyBytes {
		t.Fatal("fixture did not exercise sixfold JSON control escaping")
	}
	response, _ := fixture.request(t, "POST", "/api/skills", wire)
	if response.StatusCode != 200 {
		t.Fatal("bounded control-escaped skill was rejected")
	}
	oversized, _ := json.Marshal(struct {
		Description string `json:"description"`
	}{strings.Repeat("x", config.APIJSONBodyBytes)})
	forwarded := fixture.bridge.requests.Load()
	response, _ = fixture.request(t, "PATCH", "/api/skills/"+input.Name, oversized)
	if response.StatusCode != 413 || fixture.bridge.requests.Load() != forwarded {
		t.Fatalf("oversized JSON crossed Controller boundary: status=%d forwarded=%d", response.StatusCode, fixture.bridge.requests.Load()-forwarded)
	}
	request, err := http.NewRequestWithContext(t.Context(), "PATCH", fixture.workerOrigin+"/api/skills/"+input.Name, bytes.NewReader(oversized))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Dant-Token", fixture.workerToken)
	response, err = fixture.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 413 {
		t.Fatal("Worker accepted an oversized JSON body")
	}
	snapshot, err := fixture.worker.skills.ExportSnapshot(t.Context(), input.Name)
	if err != nil || snapshot.BinaryFiles["assets/control.txt"].Data == "" {
		t.Fatal("rejected oversized patch changed existing skill content")
	}
}
