package app

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestWorkerHumanConversationStartupRejectionKeepsAPIAndDesktopOwner(t *testing.T) {
	app, wire := connectedWorkerFixture(t, nil)
	if err := app.engine.Acquire(t.Context()); err != nil {
		t.Fatal(err)
	}
	// The synthetic original RPC returns an invalid config/read response. This
	// exercises the production concrete-session to Engine-interface adapter.
	body := `{"text":"synthetic conversation while human controls desktop","clientMessageId":"d02c98ec-1cfb-45b2-928d-2ef69757c0bb"}`
	response := callWorker(app, http.MethodPost, "/api/messages", body)
	requireWorkerStatus(t, response, http.StatusOK)
	var accepted contracts.ChatMessage
	if err := json.Unmarshal(response.Body.Bytes(), &accepted); err != nil || accepted.ID == "" {
		t.Fatal("conversation admission lost its message identity", err)
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(time.Millisecond)
	defer poll.Stop()
	for {
		saved, err := app.store.Message(accepted.ID)
		state := app.engine.Snapshot()
		if err == nil && saved.Status.Value == contracts.MessageStatus(contracts.TaskStatusFailed) && state.Active == nil {
			if saved.Submission.Value != contracts.SubmissionStatusNotSubmitted || saved.UnknownOutcome || saved.TurnID.Value != "" || saved.WorkID != "" {
				t.Fatal("known startup rejection became submitted work")
			}
			if !state.Takeover || !state.Executor.Paused || !state.Executor.ConfirmedStopped || len(state.Queue) != 0 {
				t.Fatal("conversation startup failure released desktop control or resumed work")
			}
			break
		}
		select {
		case <-poll.C:
		case <-deadline.C:
			t.Fatal("rejected conversation did not finish within its startup deadline")
		case <-t.Context().Done():
			t.Fatal("test scope ended before conversation cleanup")
		}
	}
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/state", ""), http.StatusOK)
	if app.worker.Snapshot().Status != contracts.ConnectionStatusOnline || len(app.store.Snapshot().WorkTasks) != 0 {
		t.Fatal("conversation child failure disconnected the main executor or created durable work")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/messages", body), http.StatusOK)
	if wire.count("config/read") != 1 || wire.count("thread/start") != 0 || wire.count("turn/start") != 0 || len(app.store.Snapshot().Messages) != 1 {
		t.Fatal("startup rejection or duplicate receipt executed or replayed a request")
	}
}
