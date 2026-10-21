package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestIdleConnectionRestoresAgentWithoutResumingOrRewritingUnknownWork(t *testing.T) {
	for _, stopUnknown := range []bool{false, true} {
		name := "stopped executor"
		if stopUnknown {
			name = "durable stop uncertainty"
		}
		t.Run(name, func(t *testing.T) {
			app, wire := connectedWorkerFixture(t, nil)
			if err := app.engine.Pause(t.Context()); err != nil {
				t.Fatal(err)
			}
			message, err := app.store.Add(t.Context(), &contracts.ChatMessage{
				Role:           contracts.RoleUser,
				Text:           "isolated unknown history",
				Status:         contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
				Submission:     contracts.Some(contracts.SubmissionStatusUnknown),
				UnknownOutcome: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := app.store.Mutate(t.Context(), func(state *contracts.State) error {
				state.WorkTasks = append(state.WorkTasks, contracts.WorkRecord{
					ID: "unknown-fixture-work", Status: contracts.WorkStatusUnknown, UnknownOutcome: true,
				})
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			wire.mu.Lock()
			writer := wire.writer
			wire.mu.Unlock()
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(time.Second)
			for app.worker.Snapshot().Status != contracts.ConnectionStatusOffline && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if app.worker.Snapshot().Status != contracts.ConnectionStatusOffline {
				t.Fatal("the isolated lost RPC was not observed")
			}
			if stopUnknown {
				if err := app.engine.FenceUnconfirmedStop(t.Context()); err != nil {
					t.Fatal(err)
				}
			}
			before := app.store.Snapshot()
			originalMessage, _ := app.store.Message(message.ID)
			originalRaw, _ := json.Marshal(originalMessage)
			originalWork, _ := json.Marshal(before.WorkTasks)
			initializations := wire.count("initialize")
			response := callWorker(app, http.MethodPost, "/api/connect", `{"idleRecovery":true}`)
			wantStatus := 200
			if stopUnknown {
				wantStatus = 409
			}
			requireWorkerStatus(t, response, wantStatus)
			after := app.store.Snapshot()
			retainedMessage, _ := app.store.Message(message.ID)
			retainedRaw, _ := json.Marshal(retainedMessage)
			retainedWork, _ := json.Marshal(after.WorkTasks)
			if !bytes.Equal(originalRaw, retainedRaw) || !bytes.Equal(originalWork, retainedWork) ||
				!app.engine.Snapshot().Executor.Paused || wire.count("turn/start") != 0 ||
				wire.count("thread/start") != 0 || wire.count("thread/resume") != 0 {
				t.Fatal("idle agent connection resumed or rewrote retained unknown work")
			}
			if stopUnknown {
				if wire.count("initialize") != initializations || !app.engine.UnconfirmedStop() {
					t.Fatal("an unresolved stop fence authorized another executor")
				}
			} else if app.worker.Snapshot().Status != contracts.ConnectionStatusOnline ||
				wire.count("initialize") != initializations+1 {
				t.Fatal("the stopped isolated executor was not replaced exactly once")
			}
		})
	}
}
