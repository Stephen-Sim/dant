package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
)

type appFailedReader struct{}

func (appFailedReader) Read([]byte) (int, error) {
	return 0, errors.New("private synthetic read failure")
}

func TestWorkerDesktopRoutesUseOnlyCurrentControlSessionAndBoundedReadOnlyScreen(t *testing.T) {
	var inputs atomic.Int32
	var badScreen atomic.Bool
	sessionID := "synthetic-control-session"
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10}
	app, _ := connectedWorkerFixture(t, func(options *WorkerOptions) {
		options.WorkerOptions.Client = appHTTPFunc(func(request *http.Request) (*http.Response, error) {
			result := contracts.RawObject{}
			switch request.URL.Path {
			case "/screen":
				body := io.Reader(bytes.NewReader(png))
				if badScreen.Load() {
					body = appFailedReader{}
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(body)}, nil
			case "/control":
				var body struct {
					Action string `json:"action"`
				}
				if json.NewDecoder(request.Body).Decode(&body) != nil {
					t.Error("invalid synthetic control request")
				}
				result = contracts.RawObject{"status": encode(contracts.ComputerControlStatusHuman), "sessionId": encode(sessionID), "expiresAt": encode(time.Now().Add(2 * time.Minute).UnixMilli())}
				if body.Action == "release" {
					result = contracts.RawObject{"status": encode(contracts.ComputerControlStatusDant), "sessionId": encode(nil), "expiresAt": encode(0)}
				}
			case "/input":
				inputs.Add(1)
				result = contracts.RawObject{"ok": encode(true), "expiresAt": encode(time.Now().Add(2 * time.Minute).UnixMilli())}
			default:
				t.Error("unexpected desktop route")
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(encode(result)))}, nil
		})
	})
	if !app.canSchedule() {
		t.Fatal("idle connected Worker did not expose schedule availability")
	}
	response := callWorker(app, http.MethodGet, "/api/screen", "")
	requireWorkerStatus(t, response, 200)
	if !bytes.Equal(response.Body.Bytes(), png) || response.Header().Get("Content-Type") != "image/png" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("screen bytes or safe headers changed")
	}
	badScreen.Store(true)
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/screen", ""), 502)
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/takeover", `{"enabled":true}`), 200)
	if app.canSchedule() {
		t.Fatal("human computer control allowed autonomous scheduling")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/input", `{"sessionId":"stale","type":"click","x":1,"y":1}`), 409)
	if inputs.Load() != 0 {
		t.Fatal("stale human session reached desktop input")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/input", `{"sessionId":"`+sessionID+`","type":"click","x":1,"y":1}`), 200)
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/takeover", `{"enabled":false,"sessionId":"`+sessionID+`"}`), 200)
	if inputs.Load() != 1 || app.engine.Snapshot().Takeover || !app.engine.Snapshot().Executor.Paused || app.canSchedule() {
		t.Fatal("input replayed, release retained control, or paused work resumed implicitly")
	}
}

func TestWorkerConnectLoginLogoutAreSingleAdmissionOperationsWhileActiveWorkIsProtected(t *testing.T) {
	app, wire := connectedWorkerFixture(t, nil)
	for _, request := range []struct{ route, body string }{
		{"/api/connect", `{"idleRecovery":true}`}, {"/api/connect", `{}`},
		{"/api/login", `{}`}, {"/api/logout", `{}`},
	} {
		requireWorkerStatus(t, callWorker(app, http.MethodPost, request.route, request.body), 200)
	}
	if wire.count("account/login/start") != 1 || wire.count("account/logout") != 1 || wire.count("turn/start") != 0 {
		t.Fatal("connection management admitted a task or replayed account effects")
	}
	active, activeWire, _ := acknowledgedToolFixture(t)
	for _, route := range []string{"/api/connect", "/api/login", "/api/logout"} {
		requireWorkerStatus(t, callWorker(active, http.MethodPost, route, `{"idleRecovery":true}`), 409)
	}
	if activeWire.count("account/login/start") != 0 || activeWire.count("account/logout") != 0 || activeWire.count("turn/start") != 1 {
		t.Fatal("active task lost connection admission protection")
	}
}

func TestWorkerProgressAcceptanceAndCompletionClearArePersistentAndExplicit(t *testing.T) {
	app := fixtureWorker(t)
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "reviewed fixture", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusReview)),
	})
	if err != nil {
		t.Fatal(err)
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/tasks/"+message.ID+"/accept", `{}`), 200)
	saved, _ := app.store.Message(message.ID)
	if saved.Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) || !saved.AcceptedAt.Present {
		t.Fatal("explicit acceptance did not complete the chosen task")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/tasks/clear-completed", `{}`), 200)
	saved, _ = app.store.Message(message.ID)
	if !saved.ProgressDismissedAt.Present || saved.Text != message.Text {
		t.Fatal("clear completed deleted content or failed to hide progress")
	}
	paused, err := app.store.Add(t.Context(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "paused future work", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
	})
	if err != nil {
		t.Fatal(err)
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/retry/"+paused.ID, `{"confirmUnknown":"yes"}`), 400)
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/retry/"+paused.ID, `{}`), 409)
	if saved, _ := app.store.Message(paused.ID); saved.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) {
		t.Fatal("offline retry rewrote paused state")
	}
}

func TestWorkerVoiceMessageToolUsesOnlyInjectedHelperAndArchivesExactBytes(t *testing.T) {
	var helpers atomic.Int32
	app, _ := connectedWorkerFixture(t, func(options *WorkerOptions) {
		options.WorkerOptions.RunVoiceMessage = func(ctx context.Context, input workerRuntime.VoiceMessageCommand) ([]byte, error) {
			helpers.Add(1)
			file := filepath.Join(input.OutputDirectory, "synthetic.wav")
			if err := os.WriteFile(file, []byte("synthetic audio fixture"), 0o600); err != nil {
				return nil, err
			}
			return encode(workerRuntime.VoiceFile{Path: file, Type: "audio/wav"}), nil
		}
	})
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "entrusted synthetic helper task"})
	if err != nil {
		t.Fatal(err)
	}
	changes, stop := app.engine.Subscribe()
	defer stop()
	if err := app.engine.Enqueue(t.Context(), message); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		if owner, current := app.engine.ToolScope(); current {
			raw := runAcknowledgedTool(t, app, owner, "create_voice_message", `{"text":"synthetic spoken fixture","voice":"en-US"}`)
			if !strings.Contains(string(raw), `"sent":true`) || helpers.Load() != 1 {
				t.Fatal("voice helper delivery lost its receipt or replayed")
			}
			break
		}
		select {
		case <-changes:
		case <-deadline.C:
			t.Fatal("voice fixture task was not acknowledged")
		}
	}
	state := app.store.Snapshot()
	if len(state.Messages) != 2 || len(state.Messages[1].Attachments) != 1 || state.Messages[1].TaskID.Value != message.ID {
		t.Fatal("voice helper output lost exact task association")
	}
}
