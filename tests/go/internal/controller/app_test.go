package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/platform"
	"github.com/Stephen-Sim/dant/core/internal/voice/captions"
	"github.com/coder/websocket"
)

type controllerBridgeFixture struct {
	mu               sync.Mutex
	options          computer.BridgeOptions
	state            contracts.WorkerSnapshot
	status           contracts.ConnectionStatus
	generation       uint64
	request          func(context.Context, string, string, http.Header, io.Reader) (*http.Response, error)
	connects, pauses int
}

func (bridge *controllerBridgeFixture) Status() contracts.ConnectionStatus {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return bridge.status
}

func (bridge *controllerBridgeFixture) Generation() uint64 {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return bridge.generation
}

func (bridge *controllerBridgeFixture) Snapshot() contracts.WorkerSnapshot {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return bridge.state
}

func (bridge *controllerBridgeFixture) Connect(context.Context, bool) error {
	bridge.mu.Lock()
	bridge.connects++
	bridge.status = contracts.ConnectionStatusOnline
	bridge.generation++
	bridge.mu.Unlock()
	return nil
}

func (bridge *controllerBridgeFixture) Refresh(context.Context) (contracts.WorkerSnapshot, error) {
	state := bridge.Snapshot()
	raw, _ := json.Marshal(state)
	bridge.options.Event(computer.BridgeEvent{Generation: bridge.Generation(), Type: "state", Data: raw})
	return state, nil
}

func (bridge *controllerBridgeFixture) Prepare(context.Context) error { return nil }
func (bridge *controllerBridgeFixture) PauseWorkForUpdate(context.Context, string) error {
	bridge.mu.Lock()
	bridge.pauses++
	bridge.mu.Unlock()
	return nil
}

func (bridge *controllerBridgeFixture) Disconnect() {
	bridge.mu.Lock()
	bridge.status = contracts.ConnectionStatusOffline
	bridge.generation++
	bridge.mu.Unlock()
}

func (bridge *controllerBridgeFixture) Request(ctx context.Context, method, route string, headers http.Header, body io.Reader) (*http.Response, error) {
	if bridge.request != nil {
		return bridge.request(ctx, method, route, headers, body)
	}

	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
}

func (bridge *controllerBridgeFixture) Close() {}
func controllerAppFixture(t *testing.T) (*App, *controllerBridgeFixture, *httptest.Server, string) {
	t.Helper()
	root := t.TempDir()
	data := filepath.Join(root, "data")
	os.Mkdir(data, 0700)
	os.Mkdir(filepath.Join(root, "dist"), 0700)
	os.WriteFile(filepath.Join(root, "dist", "index.html"), []byte("isolated UI"), 0600)
	profiles, err := computer.NewProfiles(computer.ProfileOptions{DataDir: data, ProjectRoot: root, RegistryFile: filepath.Join(root, "profiles.json"), Owner: "fixture-owner"})
	if err != nil {
		t.Fatal(err)
	}
	host, err := platform.New("linux", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	bridge := &controllerBridgeFixture{status: contracts.ConnectionStatusOffline, state: emptyWorkerSnapshot()}
	app, err := New(context.Background(), Options{Root: root, DataDir: data, Version: "0.4.7-beta.12", BuildSource: strings.Repeat("a", 40), Host: host, PrepareOnly: true, Profiles: profiles, BridgeFactory: func(options computer.BridgeOptions) (Bridge, error) { bridge.options = options; return bridge, nil }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	server := httptest.NewServer(app.Handler())
	t.Cleanup(server.Close)
	response, err := server.Client().Get(server.URL + "/api/session")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var session struct{ Token string }
	if json.NewDecoder(response.Body).Decode(&session) != nil || session.Token == "" {
		t.Fatal("session bootstrap failed")
	}

	return app, bridge, server, session.Token
}

func controllerRequest(t *testing.T, server *httptest.Server, token, method, path, body string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}

	if token != "" {
		request.Header.Set("X-Dant-Token", token)
	}

	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}

	return response
}

func TestControllerKeepsSettingsAndVersionAvailableOfflineAndPreservesAuthority(t *testing.T) {
	app, bridge, server, token := controllerAppFixture(t)
	response := controllerRequest(t, server, "", "GET", "/api/state", "")
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("unauthenticated state read admitted")
	}
	response = controllerRequest(t, server, token, "GET", "/api/controller/settings", "")
	var recovery struct {
		Version string
		Status  contracts.ConnectionStatus
		VM      struct {
			User string
			Port int
		}
	}
	json.NewDecoder(response.Body).Decode(&recovery)
	response.Body.Close()
	if response.StatusCode != 200 || recovery.Version != "0.4.7-beta.12" || recovery.Status != contracts.ConnectionStatusOffline {
		t.Fatal("offline recovery configuration unavailable")
	}
	if recovery.VM.User != "dant" || recovery.VM.Port != 22 {
		t.Fatal("offline recovery lost the standard SSH connection defaults")
	}
	response = controllerRequest(t, server, token, "PATCH", "/api/settings", `{"language":"en","theme":"dark","fontSize":15}`)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("offline local preferences failed")
	}
	state := app.Snapshot()
	if state.Mode != "vm-controller" || state.Settings.Language != "en" || state.Settings.Extra["theme"] == nil {
		t.Fatal("Controller preferences did not overlay cache")
	}

	if bridge.connects != 0 || bridge.pauses != 0 {
		t.Fatal("local settings executed worker actions")
	}

	if _, err := os.Lstat(filepath.Join(app.options.DataDir, "state.json")); !os.IsNotExist(err) {
		t.Fatal("Controller created an authoritative conversation")
	}
	response = controllerRequest(t, server, token, "GET", "/api/version", "")
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !bytes.Contains(raw, []byte(`"version":"0.4.7-beta.12"`)) {
		t.Fatal("version route unavailable")
	}
}

func TestControllerProxyKeepsRawAttachmentBytesAndStripsHostCredentials(t *testing.T) {
	_, bridge, server, token := controllerAppFixture(t)
	content := bytes.Repeat([]byte{0, 255, 'x'}, 10000)
	bridge.request = func(ctx context.Context, method, route string, headers http.Header, body io.Reader) (*http.Response, error) {
		if route != "/api/files/fixture?download=1" || headers.Get("X-Dant-Token") != "" || headers.Get("Cookie") != "" {
			t.Error("proxy forwarded host credentials")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}, "Content-Disposition": []string{`attachment; filename="fixture.png"`}, "Set-Cookie": []string{"must-not-forward"}}, Body: io.NopCloser(bytes.NewReader(content))}, nil
	}
	response := controllerRequest(t, server, token, "GET", "/api/files/fixture?download=1&token="+token, "")
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if !bytes.Equal(raw, content) || response.Header.Get("Content-Disposition") == "" || response.Header.Get("Set-Cookie") != "" {
		t.Fatal("attachment download changed bytes or response policy")
	}
}

func TestControllerRejectsInternalAccessBadOriginsAndInvalidPreferences(t *testing.T) {
	_, _, server, token := controllerAppFixture(t)
	for _, path := range []string{"/api/internal/credentials", "/api/internal/something"} {
		response := controllerRequest(t, server, token, "GET", path, "")
		response.Body.Close()
		if response.StatusCode != 403 {
			t.Fatal("internal worker route proxied")
		}
	}
	request, _ := http.NewRequest("GET", server.URL+"/api/session", nil)
	request.Header.Set("Origin", "https://outside.invalid")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("foreign origin allowed")
	}
	response = controllerRequest(t, server, token, "PATCH", "/api/settings", `{"notifications":null}`)
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatal("null boolean accepted")
	}
	response = controllerRequest(t, server, token, "POST", "/api/diagnostics", `{}`)
	response.Body.Close()
	if response.StatusCode != 405 {
		t.Fatal("diagnostics mutation allowed")
	}
}

func TestControllerIgnoresStaleConnectionObservation(t *testing.T) {
	app, bridge, _, _ := controllerAppFixture(t)
	bridge.generation = 2
	state := emptyWorkerSnapshot()
	state.ConversationID = "49954ce5-c8c5-4f6e-a7d8-531530d09479"
	raw, _ := json.Marshal(state)
	app.observe(computer.BridgeEvent{Generation: 1, Type: "state", Data: raw})
	if app.Snapshot().ConversationID != "" {
		t.Fatal("stale connection replaced offline cache")
	}
}

func TestControllerCaptionsStayTransientAndRetireDisconnectedOwners(t *testing.T) {
	app, bridge, _, _ := controllerAppFixture(t)
	bridge.mu.Lock()
	bridge.status = contracts.ConnectionStatusOnline
	bridge.generation = 1
	bridge.mu.Unlock()
	state := emptyWorkerSnapshot()
	state.Worker.Status = contracts.ConnectionStatusOnline
	state.ConversationID = "49954ce5-c8c5-4f6e-a7d8-531530d09479"
	state.Call = &contracts.Call{ID: "fixture-call", Provider: "subscription", Status: "connected"}
	state.Extra["callCaption"], _ = json.Marshal(captions.Caption{CallID: "fixture-call", Provider: "subscription", Sequence: 1, Text: "isolated transient caption", Final: true})
	raw, _ := json.Marshal(state)
	app.observe(computer.BridgeEvent{Generation: 1, Type: "state", Data: raw})
	if caption := captions.ReadCaption(app.Snapshot().Extra["callCaption"]); caption == nil || caption.Text != "isolated transient caption" {
		t.Fatal("live caption was not retained")
	}
	app.mu.Lock()
	cached := app.cached
	app.mu.Unlock()
	app.saveCache(cached)
	disk, err := os.ReadFile(filepath.Join(app.options.DataDir, "state-cache.json"))
	if err != nil || bytes.Contains(disk, []byte("isolated transient caption")) {
		t.Fatal("transient caption entered persisted cache")
	}
	bridge.Disconnect()
	if caption := captions.ReadCaption(app.Snapshot().Extra["callCaption"]); caption != nil {
		t.Fatal("disconnected caption remained visible")
	}
	app.observe(computer.BridgeEvent{Generation: 1, Type: "state", Data: raw})
	if caption := captions.ReadCaption(app.Snapshot().Extra["callCaption"]); caption != nil {
		t.Fatal("retired connection revived a caption")
	}
}

func TestControllerCloseInterruptsBlockedPortableUploadAndJoinsBackup(t *testing.T) {
	app, _, server, token := controllerAppFixture(t)
	app.mu.Lock()
	app.started = true
	app.options.PrepareOnly = false
	app.mu.Unlock()
	connection, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	request := "POST /api/backups/import HTTP/1.1\r\nHost: " + strings.TrimPrefix(server.URL, "http://") + "\r\nX-Dant-Token: " + token + "\r\nContent-Type: application/octet-stream\r\nX-Dant-Backup-Passphrase: aXNvbGF0ZWQgcGFzc3BocmFzZQ==\r\nContent-Length: 1000\r\nConnection: close\r\n\r\nDA"
	if _, err := io.WriteString(connection, request); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for !app.backups.Busy() {
		select {
		case <-deadline.C:
			t.Fatal("fixture upload was not admitted")
		case <-ticker.C:
		}
	}
	closed := make(chan struct{})
	go func() { app.Close(); close(closed) }()
	select {
	case <-closed:
	case <-deadline.C:
		t.Fatal("close did not interrupt an incomplete upload")
	}
}

func TestControllerEventSocketRequiresExactOriginAndClosesWithOwner(t *testing.T) {
	app, _, server, token := controllerAppFixture(t)
	endpoint := "ws" + strings.TrimPrefix(server.URL, "http") + "/events?token=" + token
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	bad, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://outside.invalid"}}})
	if bad != nil {
		bad.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != 403 {
		t.Fatal("foreign event socket origin allowed")
	}
	socket, _, err := websocket.Dial(ctx, endpoint, nil)
	if err != nil {
		t.Fatal("event socket unavailable")
	}
	defer socket.CloseNow()
	_, initial, err := socket.Read(ctx)
	if err != nil || !bytes.Contains(initial, []byte(`"type":"state"`)) {
		t.Fatal("initial event snapshot missing")
	}
	app.Close()
	if _, _, err := socket.Read(ctx); err == nil {
		t.Fatal("event socket outlived Controller")
	}
}
