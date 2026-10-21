package work

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestConcurrentThreadRequestsShareOneHandshakeAndRespectIndividualCancellation(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() {
		_, err := engine.Thread(context.Background())
		first <- err
	}()
	request := nextRequest(t, worker, "thread/start")
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		_, err := engine.Thread(ctx)
		second <- err
	}()
	cancel()
	if err := awaitWorkAction(t, second); !errors.Is(err, context.Canceled) {
		t.Fatal("one cancelled thread waiter cancelled or bypassed the shared handshake", err)
	}
	request.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("shared-native-thread")})}}
	if err := awaitWorkAction(t, first); err != nil {
		t.Fatal(err)
	}
	if id, err := engine.Thread(context.Background()); err != nil || id != "shared-native-thread" || persistence.Snapshot().ThreadRuntime.Value != worker.RuntimeID() {
		t.Fatal("shared handshake did not retain its exact persisted binding", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestThreadBindingAdoptsMissingRuntimeButNeverReusesAForeignRuntime(t *testing.T) {
	for _, priorRuntime := range []string{"", "vm:foreign-runtime"} {
		t.Run(map[bool]string{true: "missing-runtime", false: "foreign-runtime"}[priorRuntime == ""], func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
				state.ThreadID = contracts.Some("preserved-thread")
				state.ThreadRuntime = contracts.Some(priorRuntime)
				state.ThreadConversationID = state.ConversationID
				state.Settings.Model = "fixture-model"
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			var threadID string
			go func() {
				var err error
				threadID, err = engine.Thread(context.Background())
				done <- err
			}()
			method := "thread/start"
			if priorRuntime == "" {
				method = "thread/resume"
			}
			request := nextRequest(t, worker, method)
			if eventString(request.params, "model") != "fixture-model" || string(request.params["persistExtendedHistory"]) != "false" || eventString(request.params, "approvalPolicy") != "never" {
				t.Fatal("thread handshake lost its configured model or authority policy")
			}
			if priorRuntime == "" {
				if eventString(request.params, "threadId") != "preserved-thread" || string(request.params["excludeTurns"]) != "true" {
					t.Fatal("supported saved thread binding was not adopted exactly")
				}
				request.result <- fakeResponse{value: contracts.RawObject{}}
			} else {
				var tools []json.RawMessage
				if json.Unmarshal(request.params["dynamicTools"], &tools) != nil || len(tools) != 19 {
					t.Fatal("new runtime thread lost its explicit tool declarations")
				}
				request.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("new-runtime-thread")})}}
			}
			if err := awaitWorkAction(t, done); err != nil {
				t.Fatal(err)
			}
			if priorRuntime == "" && threadID != "preserved-thread" || priorRuntime != "" && threadID != "new-runtime-thread" {
				t.Fatal("thread identity crossed into a foreign runtime")
			}
			state := persistence.Snapshot()
			if state.ThreadRuntime.Value != worker.RuntimeID() || state.ThreadConversationID != state.ConversationID || len(state.Messages) != 0 {
				t.Fatal("thread handshake changed dialogue or retained the wrong execution binding")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestInvalidOrLateThreadAcknowledgementsCannotReplaceTheCurrentConversation(t *testing.T) {
	for _, scenario := range []string{"invalid-id", "unpaired-id", "request-failed", "conversation-replaced"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			done := make(chan error, 1)
			go func() {
				_, err := engine.Thread(context.Background())
				done <- err
			}()
			request := nextRequest(t, worker, "thread/start")
			response := fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("acknowledged-thread")})}}
			switch scenario {
			case "invalid-id":
				response.value["thread"] = raw(contracts.RawObject{"id": raw("")})
			case "unpaired-id":
				response.value["thread"] = json.RawMessage(`{"id":"unsafe\ud800"}`)
			case "request-failed":
				response.err = &runtime.OperationError{Cause: runtime.ErrDisconnected, UnknownOutcome: true}
			case "conversation-replaced":
				if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
					state.ConversationID = "14cbeb5d-a1e4-4091-94de-beb2050ef71c"
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			request.result <- response
			if err := awaitWorkAction(t, done); err == nil || persistence.Snapshot().ThreadID.Value != "" || engine.Snapshot().Active != nil {
				t.Fatal("invalid or stale acknowledgement established a new execution identity", err)
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

type failingInstructionMemory struct{ failure error }

func (memory failingInstructionMemory) Context(context.Context, bool) (string, error) {
	return "", memory.failure
}

func (failingInstructionMemory) Directory() string { return "isolated-memory-directory" }

func TestThreadPreparationFailuresDoNotSubmitAnExecutionOrExposePartialInstructions(t *testing.T) {
	for _, scenario := range []string{"output-is-file", "memory-unavailable", "custom-instructions"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			switch scenario {
			case "output-is-file":
				output := engine.OutputDirectory()
				if err := os.MkdirAll(filepath.Dir(output), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(output, []byte("isolated obstruction"), 0600); err != nil {
					t.Fatal(err)
				}
			case "memory-unavailable":
				engine.options.DurableMemory = failingInstructionMemory{failure: errors.New("isolated_memory_unavailable")}
				if engine.Instructions() != "" {
					t.Fatal("failed instruction builder exposed partial authority text")
				}
			case "custom-instructions":
				engine.options.Instructions = "Fixed isolated host instruction."
				if engine.Instructions() != engine.options.Instructions {
					t.Fatal("explicit host instruction was silently replaced")
				}
				return
			}
			message, err := persistence.Add(context.Background(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "authorized isolated work"})
			if err != nil || engine.Enqueue(context.Background(), message) != nil {
				t.Fatal("fixture input was not durably queued", err)
			}
			waitSnapshot(t, engine, func(state Snapshot) bool { return state.Active == nil && len(state.Queue) == 0 })
			stored, err := persistence.Message(message.ID)
			if err != nil || stored.UnknownOutcome || stored.Submission.Value == contracts.SubmissionStatusSubmitting || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) {
				t.Fatal("pre-dispatch failure invented a submitted external action", err)
			}
			if strings.Contains(stored.Text, "isolated_memory_unavailable") {
				t.Fatal("local error replaced the user's preserved message")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}
