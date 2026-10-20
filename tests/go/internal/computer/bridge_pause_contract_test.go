package computer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type pauseProtocolFixture struct {
	mu    sync.Mutex
	state contracts.WorkerSnapshot
	posts []string
	hook  func(http.ResponseWriter, *http.Request, *pauseProtocolFixture)
}

func (protocol *pauseProtocolFixture) postCount() int {
	protocol.mu.Lock()
	defer protocol.mu.Unlock()
	return len(protocol.posts)
}

func (fixture *pauseProtocolFixture) snapshot() contracts.WorkerSnapshot {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	raw, _ := json.Marshal(fixture.state)
	var copied contracts.WorkerSnapshot
	_ = json.Unmarshal(raw, &copied)
	return copied
}

func (fixture *pauseProtocolFixture) serve(writer http.ResponseWriter, request *http.Request) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if request.Method != http.MethodPost {
		writer.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	fixture.posts = append(fixture.posts, request.URL.Path)
	if fixture.hook != nil {
		fixture.hook(writer, request, fixture)
		return
	}
	fixture.apply(writer, request)
}

func (fixture *pauseProtocolFixture) apply(writer http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "/api/takeover":
		var body struct {
			Enabled   bool   `json:"enabled"`
			SessionID string `json:"sessionId"`
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil || body.Enabled || body.SessionID != "human-owner" {
			writer.WriteHeader(http.StatusConflict)
			return
		}
		fixture.state.Takeover = false
		fixture.state.Extra["computer"] = json.RawMessage(`{"status":"dant","sessionId":null}`)
	case "/api/tasks/pause":
		fixture.state.Active = nil
		fixture.state.Queue = []string{}
	case "/api/call/stop":
		var body struct {
			CallID string `json:"callId"`
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil || fixture.state.Call == nil || fixture.state.Call.ID != body.CallID {
			writer.WriteHeader(http.StatusConflict)
			return
		}
		fixture.state.Call = nil
	case "/api/tasks/saved-work/pause":
		var body struct {
			Kind   string `json:"kind"`
			TurnID string `json:"turnId"`
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil || body.Kind != "work" || body.TurnID != "saved-turn" {
			writer.WriteHeader(http.StatusConflict)
			return
		}
		fixture.state.WorkTasks[0].Status = contracts.WorkStatusPaused
	case "/api/connect":
		var body struct {
			IdleRecovery bool `json:"idleRecovery"`
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil || !body.IdleRecovery {
			writer.WriteHeader(http.StatusConflict)
			return
		}
	default:
		writer.WriteHeader(http.StatusNotFound)
		return
	}
	_, _ = io.WriteString(writer, `{"ok":true,"paused":true,"stopped":true}`)
}

func pauseCallState() contracts.WorkerSnapshot {
	state := bridgeStateFixture()
	state.Takeover = true
	state.Extra["computer"] = json.RawMessage(`{"status":"human","sessionId":"human-owner"}`)
	state.Call = &contracts.Call{ID: "call-owner", Status: contracts.VoiceCallStatusConnected}
	state.WorkTasks = []contracts.WorkRecord{{ID: "saved-work", TurnID: "saved-turn", Status: contracts.WorkStatusContinuing}}
	return state
}

func TestPauseProtocolReleasesCapturedHumanAndCallOwnersBeforePausingSavedWork(t *testing.T) {
	fixture := &pauseProtocolFixture{state: pauseCallState()}
	bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
	if err := bridge.PauseWorkForUpdate(t.Context(), "install"); err != nil {
		t.Fatal(err)
	}
	expected := []string{
		"/api/takeover", "/api/tasks/pause", "/api/call/stop", "/api/tasks/pause",
		"/api/tasks/saved-work/pause", "/api/connect",
	}
	fixture.mu.Lock()
	actual := strings.Join(fixture.posts, ",")
	fixture.mu.Unlock()
	if actual != strings.Join(expected, ",") || !ServiceUpdateQuiescent(bridge.Snapshot(), false) {
		t.Fatal("pause did not retain the exact owner and complete quiescence sequence")
	}
	if pending, err := bridge.pauseReceipt(t.Context(), mustBinding(t, bridge), "read"); err != nil || pending {
		t.Fatal("confirmed quiescence retained an uncertain pause receipt", err)
	}
}

func TestPauseUnknownHTTPOutcomeIsReconciledWithoutRepeatingAcceptedActions(t *testing.T) {
	fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
	fixture.hook = func(writer http.ResponseWriter, _ *http.Request, _ *pauseProtocolFixture) {
		writer.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(writer, `{"error":"private response"}`)
	}
	bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
	if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); !errors.Is(err, ErrPauseUnconfirmed) {
		t.Fatal("an unconfirmed POST became successful", err)
	}
	if pending, err := bridge.pauseReceipt(t.Context(), mustBinding(t, bridge), "read"); err != nil || !pending {
		t.Fatal("an uncertain operation lost its durable fence", err)
	}
	if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); err != nil {
		t.Fatal("independently quiescent state did not reconcile the fence", err)
	}
	if fixture.postCount() != 1 {
		t.Fatal("reconciliation replayed an external pause")
	}
}

func TestPauseRejectsUnsafeSnapshotsBeforeCreatingAnActionFence(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*contracts.WorkerSnapshot)
	}{
		{"missing messages", func(state *contracts.WorkerSnapshot) { state.Messages = nil }},
		{"missing work", func(state *contracts.WorkerSnapshot) { state.WorkTasks = nil }},
		{"missing queue", func(state *contracts.WorkerSnapshot) { state.Queue = nil }},
		{"executor offline", func(state *contracts.WorkerSnapshot) { state.Worker.Status = contracts.ConnectionStatusOffline }},
		{"acquiring control", func(state *contracts.WorkerSnapshot) { state.Acquiring = true }},
		{"pending control", func(state *contracts.WorkerSnapshot) {
			state.Extra["computer"] = json.RawMessage(`{"status":"dant","pending":true}`)
		}},
		{"control unknown", func(state *contracts.WorkerSnapshot) {
			state.Extra["computer"] = json.RawMessage(`{"status":"unknown"}`)
		}},
		{"human without owner", func(state *contracts.WorkerSnapshot) {
			state.Takeover = true
			state.Extra["computer"] = json.RawMessage(`{"status":"human"}`)
		}},
		{"nil message", func(state *contracts.WorkerSnapshot) { state.Messages = []*contracts.ChatMessage{nil} }},
		{"unknown message", func(state *contracts.WorkerSnapshot) {
			state.Messages = []*contracts.ChatMessage{{ID: "message", Role: contracts.RoleUser, UnknownOutcome: true}}
		}},
		{"submitting work", func(state *contracts.WorkerSnapshot) {
			state.WorkTasks = []contracts.WorkRecord{{ID: "work", Status: contracts.WorkStatusPaused, Submission: contracts.Some(contracts.SubmissionStatusSubmitting)}}
		}},
		{"invalid continuation", func(state *contracts.WorkerSnapshot) {
			state.WorkTasks = []contracts.WorkRecord{{ID: "work", Status: contracts.WorkStatusPaused, Continuation: &contracts.WorkContinuation{Invalid: true}}}
		}},
		{"unowned acknowledged dispatch", func(state *contracts.WorkerSnapshot) {
			state.WorkTasks = []contracts.WorkRecord{{ID: "work", Status: contracts.WorkStatusPaused, Continuation: &contracts.WorkContinuation{Dispatch: &contracts.ContinuationDispatch{Phase: contracts.ContinuationDispatchPhaseAcknowledged}}}}
		}},
		{"call missing owner", func(state *contracts.WorkerSnapshot) {
			state.Call = &contracts.Call{Status: contracts.VoiceCallStatusConnected}
		}},
		{"call owner too long", func(state *contracts.WorkerSnapshot) {
			state.Call = &contracts.Call{ID: strings.Repeat("a", 257), Status: contracts.VoiceCallStatusConnected}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := bridgeStateFixture()
			test.mutate(&state)
			fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
			bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
			fixture.mu.Lock()
			fixture.state = state
			fixture.mu.Unlock()
			if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); !errors.Is(err, ErrPauseUnconfirmed) {
				t.Fatal("an incomplete observation admitted a pause", err)
			}
			if fixture.postCount() != 0 {
				t.Fatal("unsafe input reached a mutation endpoint")
			}
			if _, err := os.Stat(filepath.Join(bridge.options.DataDir, "vm-work-pause.json")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("unsafe input was recorded as an attempted action", err)
			}
		})
	}
}

func TestPauseRejectsMalformedReceiptsAndChangedCallOwnersWithoutAReplay(t *testing.T) {
	for _, response := range []string{`{`, `[]`, `{"ok":true,"ok":true}`, `{"ok":false}`, strings.Repeat("x", 65537)} {
		t.Run("bounded response", func(t *testing.T) {
			fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
			fixture.hook = func(writer http.ResponseWriter, _ *http.Request, _ *pauseProtocolFixture) {
				_, _ = io.WriteString(writer, response)
			}
			bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
			if err := bridge.PauseWorkForUpdate(t.Context(), "install"); !errors.Is(err, ErrPauseUnconfirmed) || fixture.postCount() != 1 {
				t.Fatal("a malformed response was trusted or retried", err)
			}
		})
	}
	fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
	fixture.state.Call = &contracts.Call{ID: "original-call", Status: contracts.VoiceCallStatusConnected}
	fixture.hook = func(writer http.ResponseWriter, request *http.Request, current *pauseProtocolFixture) {
		current.apply(writer, request)
		current.state.Call = &contracts.Call{ID: "new-call", Status: contracts.VoiceCallStatusConnected}
	}
	bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
	if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); !errors.Is(err, ErrPauseUnconfirmed) || fixture.postCount() != 1 {
		t.Fatal("the old call's confirmation stopped a replacement call", err)
	}
}

func TestPauseBindingReplacementCannotApplyThePreviousOwnersReceipt(t *testing.T) {
	fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
	bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
	before := mustBinding(t, bridge)
	fixture.mu.Lock()
	fixture.hook = func(writer http.ResponseWriter, _ *http.Request, _ *pauseProtocolFixture) {
		replacement := before
		replacement.Host = "replacement.invalid"
		raw, _ := json.Marshal(replacement)
		if err := os.WriteFile(filepath.Join(bridge.options.DataDir, "vm.json"), raw, 0600); err != nil {
			t.Error(err)
		}
		_, _ = io.WriteString(writer, `{"ok":true}`)
	}
	fixture.mu.Unlock()
	if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); !errors.Is(err, ErrPauseUnconfirmed) || fixture.postCount() != 1 {
		t.Fatal("a replacement binding inherited the old operation", err)
	}
	if pending, err := bridge.pauseReceipt(t.Context(), before, "read"); err != nil || !pending {
		t.Fatal("identity change erased the original unknown outcome", err)
	}
}

func TestPauseSerializesAnInFlightMutationAndJoinsCallerCancellation(t *testing.T) {
	fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
	entered := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	fixture.hook = func(_ http.ResponseWriter, request *http.Request, _ *pauseProtocolFixture) {
		_, _ = io.Copy(io.Discard, request.Body)
		close(entered)
		select {
		case <-request.Context().Done():
		case <-release:
		}
	}
	bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		finished <- bridge.PauseWorkForUpdate(ctx, "exit")
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("the fixture mutation was not admitted")
	}
	if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); !errors.Is(err, ErrBridgeBusy) {
		t.Fatal("concurrent pause admitted a duplicate mutation", err)
	}
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, ErrPauseUnconfirmed) {
			t.Fatal("cancelled mutation was declared successful", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pause did not join its cancelled request")
	}
}

func TestPauseInvalidDurableFencesCannotBecomePermissionToReplay(t *testing.T) {
	full := pauseReceipt{SchemaVersion: 1, Entries: []string{}}
	for index := range pauseReceiptEntryLimit + 1 {
		full.Entries = append(full.Entries, fmt.Sprintf("%064x", index))
	}
	oversized, _ := json.Marshal(full)
	for _, raw := range []string{
		`{`, `[]`, `{"schemaVersion":2,"entries":[]}`, `{"schemaVersion":1,"entries":null}`,
		`{"schemaVersion":1,"entries":["not-a-binding-digest"]}`,
		`{"schemaVersion":1,"entries":[],"entries":[]}`, string(oversized),
	} {
		t.Run("invalid durable receipt", func(t *testing.T) {
			fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
			bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
			file := filepath.Join(bridge.options.DataDir, "vm-work-pause.json")
			if err := os.WriteFile(file, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); !errors.Is(err, ErrPauseUnconfirmed) || fixture.postCount() != 0 {
				t.Fatal("invalid history admitted another action", err)
			}
			current, _ := os.ReadFile(file)
			if string(current) != raw {
				t.Fatal("unknown history was overwritten")
			}
		})
	}
	fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
	bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
	file := filepath.Join(bridge.options.DataDir, "vm-work-pause.json")
	if err := os.Mkdir(file, 0700); err != nil {
		t.Fatal(err)
	}
	if err := bridge.PauseWorkForUpdate(t.Context(), "install"); !errors.Is(err, ErrPauseUnconfirmed) || fixture.postCount() != 0 {
		t.Fatal("unreadable durable history admitted an action", err)
	}
	if err := bridge.PauseWorkForUpdate(t.Context(), "unknown reason"); !errors.Is(err, ErrPauseUnconfirmed) {
		t.Fatal("unknown pause reason was accepted", err)
	}
}

func TestSavedWorkRequiresItsCapturedTurnAndAnExplicitPauseReceipt(t *testing.T) {
	for _, variant := range []string{"missing id", "missing turn", "long id", "long turn", "unpaused receipt", "call not stopped", "late active", "generation changed"} {
		t.Run(variant, func(t *testing.T) {
			fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
			fixture.state.WorkTasks = []contracts.WorkRecord{{ID: "saved-work", TurnID: "saved-turn", Status: contracts.WorkStatusContinuing}}
			if variant == "call not stopped" {
				fixture.state.Call = &contracts.Call{ID: "call-owner", Status: contracts.VoiceCallStatusConnected}
			}
			var bridge *VMBridge
			pauses := 0
			fixture.hook = func(writer http.ResponseWriter, request *http.Request, current *pauseProtocolFixture) {
				if request.URL.Path == "/api/tasks/pause" {
					pauses++
					if pauses == 2 {
						switch variant {
						case "missing id":
							current.state.WorkTasks[0].ID = ""
						case "missing turn":
							current.state.WorkTasks[0].TurnID = ""
						case "long id":
							current.state.WorkTasks[0].ID = strings.Repeat("w", 129)
						case "long turn":
							current.state.WorkTasks[0].TurnID = strings.Repeat("t", 257)
						}
					}
				}
				if variant == "unpaused receipt" && request.URL.Path == "/api/tasks/saved-work/pause" {
					_, _ = io.WriteString(writer, `{"ok":true,"paused":false}`)
					return
				}
				if variant == "call not stopped" && request.URL.Path == "/api/call/stop" {
					_, _ = io.WriteString(writer, `{"stopped":false}`)
					return
				}
				current.apply(writer, request)
				if variant == "late active" && request.URL.Path == "/api/connect" {
					current.state.Active = &contracts.ActiveExecution{WorkID: "replacement", Status: contracts.TaskStatusRunning, Step: contracts.TaskProgressStageWorking}
				}
				if variant == "generation changed" {
					bridge.Disconnect()
				}
			}
			bridge = newBridgeFixture(t, fixture.snapshot, fixture.serve)
			if err := bridge.PauseWorkForUpdate(t.Context(), "exit"); !errors.Is(err, ErrPauseUnconfirmed) {
				t.Fatal("a changed owner or incomplete receipt was accepted", err)
			}
		})
	}
}

func TestBindingIdentityKeepsEveryLegacyJSONEscapeWithoutHTMLEscaping(t *testing.T) {
	binding := Binding{Host: "fixture.invalid", User: "dant", Port: 22, KeyPath: "\"\\\b\f\n\r\t\x00\x0b<>&\u2028\u2029", KnownHosts: "hosts"}
	expected := "[\"fixture.invalid\",\"dant\",22,\"\\\"\\\\\\b\\f\\n\\r\\t\\u0000\\u000b<>&\u2028\u2029\",\"hosts\"]"
	if BindingIdentity(binding) != expected {
		t.Fatal("a persisted binding identity changed across runtime JSON escaping")
	}
}

func TestBindingRecordDigestMatchesTheHistoricalNodeBackupIdentity(t *testing.T) {
	// Golden hashes were produced with Node 22 crypto over JSON.stringify of
	// the legacy ordered object, including omitted optional fields.
	for _, test := range []struct {
		binding Binding
		digest  string
	}{
		{
			Binding{Host: "fixture.invalid", User: "dant", Port: 22, KeyPath: "fixture-key", KnownHosts: "fixture-hosts"},
			"d9ae7fb720dc9aff40e7deab11493cbb72e7f1a140782223c3fda7d0d2e95f2b",
		},
		{
			Binding{
				Host: "fixture.invalid", User: "dant", Port: 2202, KeyPath: "<>&\u2028\u2029", KnownHosts: "hosts",
				Provider: contracts.VmProviderIdVMware, Name: "工作电脑", VMXPath: `C:\VM Folder\computer.vmx`, VMwareID: "fixture-vm",
			},
			"d4f133dc5f0c54469fafca24f7e63a6d5215329f97c45032fc7afa7b354b7fbe",
		},
	} {
		if BindingRecordDigest(test.binding) != test.digest {
			t.Fatal("a cross-runtime backup binding identity changed")
		}
	}
}

func TestPauseFailureAtEachAcknowledgementBoundaryPreservesTheUnknownFence(t *testing.T) {
	for _, stage := range []string{"release control", "observe released control", "observe first pause", "second pause", "observe second pause", "idle recovery"} {
		t.Run(stage, func(t *testing.T) {
			fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
			if strings.Contains(stage, "control") {
				fixture.state.Takeover = true
				fixture.state.Extra["computer"] = json.RawMessage(`{"status":"human","sessionId":"human-owner"}`)
			}
			pauses := 0
			fixture.hook = func(writer http.ResponseWriter, request *http.Request, current *pauseProtocolFixture) {
				if request.URL.Path == "/api/tasks/pause" {
					pauses++
				}
				if (stage == "release control" && request.URL.Path == "/api/takeover") ||
					(stage == "idle recovery" && request.URL.Path == "/api/connect") {
					writer.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				if stage == "second pause" && pauses == 2 {
					_, _ = io.WriteString(writer, `{"ok":"not a boolean"}`)
					return
				}
				current.apply(writer, request)
				if (stage == "observe released control" && request.URL.Path == "/api/takeover") ||
					(stage == "observe first pause" && pauses == 1) ||
					(stage == "observe second pause" && pauses == 2) {
					current.state.Worker.Status = contracts.ConnectionStatusOffline
				}
			}
			bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
			if err := bridge.PauseWorkForUpdate(t.Context(), "install"); !errors.Is(err, ErrPauseUnconfirmed) {
				t.Fatal("a partial sequence was classified as safely paused", err)
			}
			if pending, err := bridge.pauseReceipt(t.Context(), mustBinding(t, bridge), "read"); err != nil || !pending {
				t.Fatal("a failed acknowledgement boundary lost its unknown-outcome fence", err)
			}
			posts := fixture.postCount()
			_ = bridge.PauseWorkForUpdate(t.Context(), "install")
			if fixture.postCount() != posts {
				t.Fatal("a second request replayed the uncertain action")
			}
		})
	}
}

func TestPauseAcknowledgedDispatchRequiresTheExactActiveTurnOrWorkOwner(t *testing.T) {
	for _, variant := range []string{"matching turn", "matching work", "foreign owner", "unacknowledged"} {
		t.Run(variant, func(t *testing.T) {
			fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
			fixture.state.Active = &contracts.ActiveExecution{
				WorkID: "another-work", TurnID: contracts.Some("another-turn"),
				Status: contracts.TaskStatusRunning, Step: contracts.TaskProgressStageWorking,
			}
			fixture.state.WorkTasks = []contracts.WorkRecord{{
				ID: "owned-work", TurnID: "owned-turn", Status: contracts.WorkStatusPaused,
				Continuation: &contracts.WorkContinuation{Dispatch: &contracts.ContinuationDispatch{
					Phase: contracts.ContinuationDispatchPhaseAcknowledged,
				}},
			}}
			switch variant {
			case "matching turn":
				fixture.state.Active.TurnID = contracts.Some("owned-turn")
			case "matching work":
				fixture.state.Active.WorkID = "owned-work"
			case "unacknowledged":
				fixture.state.WorkTasks[0].Continuation.Dispatch.Phase = contracts.ContinuationDispatchPhaseSubmitting
			}
			fixture.hook = func(writer http.ResponseWriter, request *http.Request, current *pauseProtocolFixture) {
				current.apply(writer, request)
				if request.URL.Path == "/api/tasks/pause" {
					current.state.WorkTasks[0].Continuation = nil
				}
			}
			bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
			err := bridge.PauseWorkForUpdate(t.Context(), "exit")
			if variant == "foreign owner" || variant == "unacknowledged" {
				if !errors.Is(err, ErrPauseUnconfirmed) || fixture.postCount() != 0 {
					t.Fatal("an unowned or unacknowledged dispatch reached a mutation endpoint", err)
				}
			} else if err != nil || !ServiceUpdateQuiescent(bridge.Snapshot(), false) {
				t.Fatal("an exact acknowledged owner could not be safely paused", err)
			}
		})
	}
}

func TestPauseMissingBindingCancelledCallerAndFullHistoryNeverAdmitANewMutation(t *testing.T) {
	for _, variant := range []string{"missing binding", "cancelled", "full history"} {
		t.Run(variant, func(t *testing.T) {
			fixture := &pauseProtocolFixture{state: bridgeStateFixture()}
			bridge := newBridgeFixture(t, fixture.snapshot, fixture.serve)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch variant {
			case "missing binding":
				if err := os.Remove(filepath.Join(bridge.options.DataDir, "vm.json")); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				cancel()
			case "full history":
				receipt := pauseReceipt{SchemaVersion: 1, Entries: []string{}}
				for index := range pauseReceiptEntryLimit {
					receipt.Entries = append(receipt.Entries, fmt.Sprintf("%064x", index))
				}
				raw, _ := json.Marshal(receipt)
				if err := os.WriteFile(filepath.Join(bridge.options.DataDir, "vm-work-pause.json"), raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := bridge.PauseWorkForUpdate(ctx, "exit"); !errors.Is(err, ErrPauseUnconfirmed) || fixture.postCount() != 0 {
				t.Fatal("an invalid operation boundary admitted another mutation", err)
			}
		})
	}
}
