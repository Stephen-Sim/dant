package app

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestWorkerExplicitResumeRoutesKeepExactTaskIdentityAndDoNotReplayUnknownWork(t *testing.T) {
	for _, route := range []string{"retry", "resume-list"} {
		t.Run(route, func(t *testing.T) {
			app, wire := connectedWorkerFixture(t, nil)
			message, err := app.store.Add(t.Context(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "explicitly resume synthetic paused task",
				Status:     contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
				Submission: contracts.Some(contracts.SubmissionStatusUnknown), UnknownOutcome: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			endpoint, body := "/api/retry/"+message.ID, `{"confirmUnknown":true}`
			if route == "resume-list" {
				endpoint, body = "/api/tasks/resume", `{"ids":["`+message.ID+`"],"confirmUnknown":true}`
			}
			requireWorkerStatus(t, callWorker(app, http.MethodPost, endpoint, strings.ReplaceAll(body, "true", "false")), 409)
			if wire.count("turn/start") != 0 {
				t.Fatal("unknown outcome was replayed without explicit confirmation")
			}
			requireWorkerStatus(t, callWorker(app, http.MethodPost, endpoint, body), 200)
			saved, err := app.store.Message(message.ID)
			if err != nil || saved.ClientMessageID != message.ClientMessageID || saved.Text != message.Text || saved.UnknownOutcome {
				t.Fatal("explicit resume changed the message identity or retained unknown admission")
			}
		})
	}

	app, wire := connectedWorkerFixture(t, nil)
	record, err := app.store.RegisterWork(t.Context(), store.RegisterWorkOptions{
		TurnID: "finished-fixture-turn", Source: "chat", Title: "unfinished synthetic work",
		Observed: true, Status: contracts.WorkStatusPaused,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.store.UpdateRegisteredWork(t.Context(), record.TurnID, store.UpdateRegisteredWorkOptions{
		Status: contracts.Some(contracts.WorkStatusPaused), ExecutionEnded: true,
	}); err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/tasks/" + record.ID + "/resume"
	requireWorkerStatus(t, callWorker(app, http.MethodPost, endpoint, `{"kind":"work","turnId":"stale"}`), 409)
	requireWorkerStatus(t, callWorker(app, http.MethodPost, endpoint, `{"kind":"work","turnId":"`+record.TurnID+`"}`), 200)
	state := app.store.Snapshot()
	saved, err := store.FindWork(&state, record.ID)
	if err != nil || saved.Status != contracts.WorkStatusContinuing || saved.TurnID != record.TurnID || saved.Continuation == nil || wire.count("turn/start") != 0 {
		t.Fatal("resuming durable unfinished work lost its owner or started an unrequested turn")
	}
}

func TestWorkerSteeringAndCurrentTaskPauseRouteUseAcknowledgedTurn(t *testing.T) {
	app, wire, owner := acknowledgedToolFixture(t)
	body := `{"text":"clarify entrusted fixture work","expectedTurnId":"` + owner.TurnID + `","conversationId":"` + owner.ConversationID + `"}`
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/steer", body), 200)
	if wire.count("turn/steer") != 1 || wire.count("turn/start") != 1 {
		t.Fatal("steering did not use the acknowledged turn exactly once")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/tasks/current/pause", `{"kind":"active","turnId":"`+owner.TurnID+`","conversationId":"`+owner.ConversationID+`"}`), 200)
	if wire.count("turn/interrupt") != 1 || app.engine.Snapshot().Active != nil {
		t.Fatal("explicit current task pause was not confirmed by its executor")
	}
}

func TestWorkerOutputLinkRecoveryAndVisibleAttachmentReceiptRetainSavedBytes(t *testing.T) {
	app := fixtureWorker(t)
	root := filepath.Join(app.options.Startup.WorkspaceRoot, app.store.ConversationID(), "output")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	data := []byte("isolated named output; no directory enumeration")
	if err := os.WriteFile(filepath.Join(root, "receipt.txt"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "[Named output](output/receipt.txt)"})
	if err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/messages/" + message.ID + "/output-link/resolve"
	requireWorkerStatus(t, callWorker(app, http.MethodPost, endpoint, `{`), 400)
	requireWorkerStatus(t, callWorker(app, http.MethodPost, endpoint, `{"conversationId":"`+app.store.ConversationID()+`","href":"output/unrelated.txt"}`), 400)
	response := callWorker(app, http.MethodPost, endpoint, `{"conversationId":"`+app.store.ConversationID()+`","href":"output/receipt.txt"}`)
	requireWorkerStatus(t, response, 200)
	var receipt files.RecoveryReceipt
	if json.Unmarshal(response.Body.Bytes(), &receipt) != nil || receipt.Attachment.ID == "" || receipt.MessageID != message.ID || !receipt.RestoredSnapshot {
		t.Fatal("named recovery lost the message or saved attachment identity")
	}
	_, saved, err := app.attachments.Read(t.Context(), receipt.Attachment.ID)
	if err != nil || string(saved) != string(data) {
		t.Fatal("named recovery changed output bytes")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/read", `{"ids":["`+message.ID+`"],"attachmentSnapshots":{"`+message.ID+`":["`+receipt.Attachment.ID+`"]}}`), 200)
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/read", `{"ids":["`+message.ID+`"],"attachmentSnapshots":{"`+message.ID+`":false}}`), 400)
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/read", `{"ids":["`+message.ID+`"],"conversationId":"changed"}`), 409)
}

func TestWorkerReadOnlyAndMutationFailuresNeverAdvertiseSuccess(t *testing.T) {
	app := fixtureWorker(t)
	if err := app.diagnostics.Close(); err != nil {
		t.Fatal(err)
	}
	logDirectory := app.diagnostics.Status().Directory
	if err := os.Remove(logDirectory); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logDirectory, []byte("synthetic path collision"), 0o600); err != nil {
		t.Fatal(err)
	}
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/diagnostics", ""), 500)
	if err := os.WriteFile(filepath.Join(app.options.Startup.DataDir, backups.WorkerRestoreReceiptFile), []byte("invalid fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A malformed restore receipt must remain visible as a failure rather than
	// being interpreted as proof that a new Worker has restored its data.
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/backups/info", ""), 500)
	before := app.store.Revision()
	app.engine.Close()
	for _, request := range []struct{ route, body string }{
		{"/api/stop", `{}`}, {"/api/tasks/clear-completed", `{}`},
		{"/api/tasks/missing/priority", `{"kind":"task","priority":"high"}`},
	} {
		requireWorkerStatus(t, callWorker(app, http.MethodPost, request.route, request.body), 409)
	}
	if app.store.Revision() != before {
		t.Fatal("closed executor mutation changed durable history")
	}
	if conversationRouteError(nil) != nil {
		t.Fatal("nil route error was changed")
	}
}
