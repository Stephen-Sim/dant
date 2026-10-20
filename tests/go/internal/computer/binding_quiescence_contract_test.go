package computer

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func bindingContractInput(t *testing.T) (string, map[string]any) {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "fixture-key"), []byte("isolated private key fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	return directory, map[string]any{"host": "fixture.invalid", "user": "dant", "keyPath": "fixture-key"}
}

func TestBindingNormalizationRetainsSupportedLegacyPortsAndRelativeReferences(t *testing.T) {
	for _, port := range []any{nil, 22, " 2202 ", "2.2e1", 65535} {
		directory, input := bindingContractInput(t)
		if port != nil {
			input["port"] = port
		}
		raw, _ := json.Marshal(input)
		raw = append([]byte{0xef, 0xbb, 0xbf}, raw...)
		binding, err := NormalizeBinding(raw, directory)
		if err != nil || binding.KeyPath != filepath.Join(directory, "fixture-key") || binding.KnownHosts != filepath.Join(directory, "known_hosts") || binding.Port < 1 || binding.Port > 65535 {
			t.Fatal("a supported legacy connection changed identity", err)
		}
		if _, err := os.Stat(binding.KnownHosts); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("normalization created or copied a known-hosts file", err)
		}
		args := strings.Join(SSHArgs(binding), "|")
		for _, required := range []string{"BatchMode=yes", "StrictHostKeyChecking=accept-new", "UserKnownHostsFile=" + binding.KnownHosts, binding.KeyPath} {
			if !strings.Contains(args, required) {
				t.Fatal("noninteractive SSH ownership arguments were lost")
			}
		}
	}
}

func TestBindingRejectsInvalidConsumedMetadataWithoutCreatingFiles(t *testing.T) {
	for _, test := range []struct {
		field string
		value any
	}{
		{"host", "-option"}, {"host", "fixture.invalid;command"}, {"user", "root with spaces"},
		{"keyPath", " "}, {"keyPath", "key\x00path"}, {"knownHosts", "hosts\x00path"},
		{"knownHosts", "missing-parent/known_hosts"},
		{"port", 0}, {"port", 65536}, {"port", 22.5}, {"port", "NaN"}, {"port", "Infinity"},
		{"port", "invalid"}, {"port", true}, {"port", nil},
		{"provider", "unknown"}, {"provider", ""}, {"provider", nil},
		{"name", "\x01control"}, {"name", " "}, {"name", strings.Repeat("界", 129)},
		{"vmxPath", "relative.vmx"}, {"vmxPath", filepath.Join(t.TempDir(), "wrong.txt")},
		{"vmxPath", strings.Repeat("x", 4097)}, {"vmwareId", "not-an-owned-vm"},
	} {
		t.Run(test.field, func(t *testing.T) {
			directory, input := bindingContractInput(t)
			input[test.field] = test.value
			raw, _ := json.Marshal(input)
			if _, err := NormalizeBinding(raw, directory); !errors.Is(err, ErrBinding) {
				t.Fatal("invalid consumed connection metadata was accepted", err)
			}
			entries, _ := os.ReadDir(directory)
			if len(entries) != 1 {
				t.Fatal("invalid metadata created runtime files")
			}
		})
	}
	for _, raw := range []string{`{`, `[]`, `{"host":"first","host":"second"}`, `{"host":22}`, strings.Repeat("x", bindingMaxBytes+1)} {
		directory, _ := bindingContractInput(t)
		if _, err := NormalizeBinding([]byte(raw), directory); !errors.Is(err, ErrBinding) {
			t.Fatal("invalid connection object was accepted", err)
		}
	}
}

func TestBindingRequiresAnOrdinaryBoundedNonemptyKeyAndKnownHostsParent(t *testing.T) {
	for _, variant := range []string{"missing key", "key directory", "empty key", "oversized key", "known-hosts directory", "existing known-hosts"} {
		t.Run(variant, func(t *testing.T) {
			directory, input := bindingContractInput(t)
			key := filepath.Join(directory, "fixture-key")
			want := ErrPrivateKeyMissing
			switch variant {
			case "missing key":
				_ = os.Remove(key)
			case "key directory":
				_ = os.Remove(key)
				_ = os.Mkdir(key, 0700)
			case "empty key":
				_ = os.WriteFile(key, nil, 0600)
				want = ErrBinding
			case "oversized key":
				_ = os.WriteFile(key, []byte(strings.Repeat("x", privateKeyMaxBytes+1)), 0600)
			case "known-hosts directory":
				_ = os.Mkdir(filepath.Join(directory, "known_hosts"), 0700)
				want = ErrBinding
			case "existing known-hosts":
				_ = os.WriteFile(filepath.Join(directory, "known_hosts"), []byte("preserved host identity"), 0600)
			}
			raw, _ := json.Marshal(input)
			_, err := NormalizeBinding(raw, directory)
			if variant == "existing known-hosts" {
				if err != nil {
					t.Fatal("an existing ordinary host identity was rejected", err)
				}
			} else if !errors.Is(err, want) {
				t.Fatal("invalid credential storage was accepted or misclassified", err)
			}
		})
	}
	directory := t.TempDir()
	if _, err := ReadBinding(directory); !errors.Is(err, ErrBindingMissing) {
		t.Fatal("missing binding lost its stable classification", err)
	}
	if err := os.Mkdir(filepath.Join(directory, "vm.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadBinding(directory); !errors.Is(err, ErrBinding) {
		t.Fatal("a non-file connection was accepted", err)
	}
}

func TestQuiescenceRequiresDurableWorkAndControlToBeIndependentlySettled(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*contracts.WorkerSnapshot)
	}{
		{"active", func(state *contracts.WorkerSnapshot) { state.Active = &contracts.ActiveExecution{} }},
		{"call", func(state *contracts.WorkerSnapshot) { state.Call = &contracts.Call{} }},
		{"queued", func(state *contracts.WorkerSnapshot) { state.Queue = []string{"queued"} }},
		{"takeover", func(state *contracts.WorkerSnapshot) { state.Takeover = true }},
		{"acquiring", func(state *contracts.WorkerSnapshot) { state.Acquiring = true }},
		{"offline", func(state *contracts.WorkerSnapshot) { state.Worker.Status = contracts.ConnectionStatusOffline }},
		{"control receipt absent", func(state *contracts.WorkerSnapshot) { state.Extra = nil }},
		{"control owned", func(state *contracts.WorkerSnapshot) {
			state.Extra["computer"] = json.RawMessage(`{"status":"dant","sessionId":"another-owner"}`)
		}},
		{"control pending", func(state *contracts.WorkerSnapshot) {
			state.Extra["computer"] = json.RawMessage(`{"status":"dant","pending":true}`)
		}},
		{"nil message", func(state *contracts.WorkerSnapshot) { state.Messages = []*contracts.ChatMessage{nil} }},
		{"unknown message", func(state *contracts.WorkerSnapshot) {
			state.Messages = []*contracts.ChatMessage{{UnknownOutcome: true}}
		}},
		{"unknown submission", func(state *contracts.WorkerSnapshot) {
			state.WorkTasks = []contracts.WorkRecord{{Status: contracts.WorkStatusPaused, Submission: contracts.Some(contracts.SubmissionStatusUnknown)}}
		}},
		{"dispatch", func(state *contracts.WorkerSnapshot) {
			state.WorkTasks = []contracts.WorkRecord{{Status: contracts.WorkStatusPaused, Continuation: &contracts.WorkContinuation{Dispatch: &contracts.ContinuationDispatch{Phase: contracts.ContinuationDispatchPhaseAcknowledged}}}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := bridgeStateFixture()
			test.mutate(&state)
			if ServiceUpdateQuiescent(state, false) {
				t.Fatal("an unsettled worker was declared safe to replace")
			}
		})
	}
	for _, status := range []contracts.TaskStatus{
		contracts.TaskStatusUnknown, contracts.TaskStatusRunning, contracts.TaskStatusQueued,
		contracts.TaskStatusAccepted, contracts.TaskStatusPausing, contracts.TaskStatusContinuing,
	} {
		state := bridgeStateFixture()
		state.Messages = []*contracts.ChatMessage{{Role: contracts.RoleUser, Status: contracts.Some(contracts.MessageStatus(status))}}
		if ServiceUpdateQuiescent(state, false) {
			t.Fatal("an unfinished message was treated as completed")
		}
	}
}

func TestQuiescencePreservesEndedVoiceConversationAndWaitingUserSemantics(t *testing.T) {
	for _, ended := range []contracts.Optional[float64]{
		{}, contracts.Null[float64](), contracts.Some(0.0), contracts.Some(-1.0),
		contracts.Some(math.NaN()), contracts.Some(math.Inf(1)), contracts.Some(123.0),
	} {
		state := bridgeStateFixture()
		state.WorkTasks = []contracts.WorkRecord{{Status: contracts.WorkStatus(contracts.TaskStatusWaitingUser), ExecutionEndedAt: ended}}
		value, exists := ended.Get()
		want := exists && value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
		if ServiceUpdateQuiescent(state, false) != want {
			t.Fatal("a waiting-user record lost its actual execution-ended proof")
		}
	}
	state := bridgeStateFixture()
	state.Messages = []*contracts.ChatMessage{
		{ID: "ordinary-history", Role: contracts.RoleAssistant},
		{ID: "voice-input", Role: contracts.RoleUser, WorkKind: "conversation", VoiceCallID: "ended-call", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusAccepted))},
	}
	if !ServiceUpdateQuiescent(state, false) {
		t.Fatal("an ended conversational voice input invented durable unfinished work")
	}
	state.Messages[1].TurnID = contracts.Some("accepted-work-turn")
	if ServiceUpdateQuiescent(state, false) {
		t.Fatal("a voice input with an accepted execution turn was discarded")
	}
	state.Messages = []*contracts.ChatMessage{}
	state.Worker.Status = contracts.ConnectionStatusOffline
	if !ServiceUpdateQuiescent(state, true) || ServiceUpdateQuiescent(state, false) {
		t.Fatal("offline preparation bypassed or lost its explicit stopped-worker policy")
	}
}
