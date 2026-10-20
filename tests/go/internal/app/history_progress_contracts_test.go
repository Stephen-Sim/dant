package app

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func TestWorkerHistoryEditsReadReceiptsAndReactionsPreserveExecutionIdentity(t *testing.T) {
	app := fixtureWorker(t)
	user, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "original fixture"})
	if err != nil {
		t.Fatal(err)
	}
	assistant, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "visible answer", ReplyTo: contracts.Some(user.ID)})
	if err != nil {
		t.Fatal(err)
	}
	conversation := app.store.ConversationID()
	requireWorkerStatus(t, callWorker(app, http.MethodPatch, "/api/messages/"+user.ID, `{"text":"edited fixture","resubmit":false}`), 200)
	saved, _ := app.store.Message(user.ID)
	if saved.Text != "edited fixture" || saved.TurnID.Value != "" || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("plain history edit executed work")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/messages/"+assistant.ID+"/reaction", `{"emoji":"👍","conversationId":"`+conversation+`"}`), 200)
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/read", `{"ids":["`+assistant.ID+`"],"attachmentSnapshots":{},"conversationId":"`+conversation+`"}`), 200)
	saved, _ = app.store.Message(assistant.ID)
	if !saved.Read || saved.Text != assistant.Text || saved.TurnID.Value != "" {
		t.Fatal("visible receipt changed executor state or lost read acknowledgement")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodDelete, "/api/messages/"+user.ID, ""), 200)
	saved, _ = app.store.Message(assistant.ID)
	if !saved.ReplyTo.Null || !saved.Read {
		t.Fatal("history deletion left a dangling reply or changed receipt")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodDelete, "/api/messages/missing", ""), 404)
	requireWorkerStatus(t, callWorker(app, http.MethodDelete, "/api/history", `{"confirm":true}`), 200)
	if len(app.store.Snapshot().Messages) != 0 || app.store.ConversationID() != conversation {
		t.Fatal("visible history clear changed durable conversation identity")
	}
}

func TestWorkerHistoryRejectsMalformedAndStaleRequestsBeforeAnyMutation(t *testing.T) {
	app := fixtureWorker(t)
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "read fixture"})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		method, route, body string
		status              int
	}{
		{http.MethodPatch, "/api/messages/" + message.ID, `{`, 400},
		{http.MethodPatch, "/api/messages/" + message.ID, `{"text":"replacement","unexpected":true}`, 400},
		{http.MethodPatch, "/api/messages/" + message.ID, `{"text":false}`, 400},
		{http.MethodPatch, "/api/messages/" + message.ID, `{"text":"replacement","resubmit":"yes"}`, 400},
		{http.MethodPatch, "/api/messages/missing", `{"text":"replacement"}`, 404},
		{http.MethodPatch, "/api/messages/" + message.ID + "/metadata", `{`, 400},
		{http.MethodDelete, "/api/history", `{`, 400},
		{http.MethodDelete, "/api/history", `{"confirm":1}`, 400},
		{http.MethodDelete, "/api/history", `{"confirm":false}`, 400},
		{http.MethodPost, "/api/messages/" + message.ID + "/reaction", `{`, 400},
		{http.MethodPost, "/api/messages/" + message.ID + "/reaction", `{"emoji":false}`, 400},
		{http.MethodPost, "/api/messages/" + message.ID + "/reaction", `{"emoji":"👍","conversationId":"old"}`, 409},
		{http.MethodPost, "/api/messages/missing/reaction", `{"emoji":"👍"}`, 404},
		{http.MethodPost, "/api/read", `{`, 400},
		{http.MethodPost, "/api/read", `{"ids":null}`, 400},
		{http.MethodPost, "/api/read", `{"ids":[false]}`, 400},
		{http.MethodPost, "/api/read", `{"ids":["\ud800"]}`, 400},
		{http.MethodPost, "/api/read", `{"ids":[""]}`, 400},
		{http.MethodPost, "/api/read", `{"ids":["` + strings.Repeat("a", 129) + `"]}`, 400},
		{http.MethodPost, "/api/read", `{"ids":["` + message.ID + `"],"attachmentSnapshots":null}`, 400},
		{http.MethodPost, "/api/read", `{"ids":[],"attachmentSnapshots":{"other":[]}}`, 400},
		{http.MethodPost, "/api/read", `{"ids":["` + message.ID + `"],"attachmentSnapshots":{"other":[]}}`, 400},
		{http.MethodPost, "/api/read", `{"ids":["` + message.ID + `"],"attachmentSnapshots":{"` + message.ID + `":[false]}}`, 400},
		{http.MethodPost, "/api/read", `{"ids":["` + message.ID + `"],"attachmentSnapshots":{"` + message.ID + `":["invalid-file"]}}`, 400},
		{http.MethodPost, "/api/read", `{"ids":["` + message.ID + `"],"conversationId":"old"}`, 409},
	} {
		t.Run(test.route+"/"+test.body, func(t *testing.T) {
			before := app.store.Snapshot()
			requireWorkerStatus(t, callWorker(app, test.method, test.route, test.body), test.status)
			if !reflect.DeepEqual(before, app.store.Snapshot()) || len(app.engine.Snapshot().Queue) != 0 {
				t.Fatal("rejected history request changed persistent state or admitted work")
			}
		})
	}
}

func TestWorkerMessageValidationRetainsUnsupportedScopeAndAttachmentUncertainty(t *testing.T) {
	app := fixtureWorker(t)
	for _, test := range []struct {
		body   string
		status int
	}{
		{`{`, 400}, {`{"text":"fixture","unknown":true}`, 400},
		{`{"text":"fixture","conversationId":false}`, 409},
		{`{"text":"fixture","replyTo":"\ud800"}`, 400},
		{`{"text":"fixture","clientMessageId":"\ud800"}`, 400},
		{`{"text":"fixture","clientMessageId":null}`, 400},
		{`{"text":{}}`, 400},
		{`{"text":"fixture","workReply":null}`, 409},
		{`{"text":"fixture","workReply":{"unknown":"x"}}`, 409},
		{`{"text":"fixture","workReply":{"workId":"work","turnId":"turn","conversationId":"\ud800"}}`, 409},
		{`{"text":"fixture","attachments":null}`, 400},
		{`{"text":"fixture","attachments":[""]}`, 400},
		{`{"text":"fixture","attachments":["missing","missing"]}`, 400},
		{`{"text":"fixture","attachments":["missing"]}`, 400},
	} {
		requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/messages", test.body), test.status)
		if len(app.store.Snapshot().Messages) != 0 || len(app.engine.Snapshot().Queue) != 0 {
			t.Fatal("invalid message entered durable admission")
		}
	}
}

func TestWorkerProgressManagementRetainsConfirmationIdentityAndUnfinishedRecords(t *testing.T) {
	app := fixtureWorker(t)
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "saved unfinished fixture"})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := workstate.PublicPlan([]contracts.PlanStep{{Step: "verify fixture", Status: contracts.PlanStepStatusPending}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	record, err := app.store.RegisterWork(t.Context(), store.RegisterWorkOptions{TurnID: "progress-fixture-turn", MessageID: message.ID, Source: "chat", Title: "unfinished", Plan: &plan})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.store.UpdateRegisteredWork(t.Context(), record.TurnID, store.UpdateRegisteredWorkOptions{Status: contracts.Some(contracts.WorkStatusPaused), ExecutionEnded: true}); err != nil {
		t.Fatal(err)
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/tasks/"+record.ID+"/priority", `{"kind":"work","priority":"high"}`), 200)
	state := app.store.Snapshot()
	if state.WorkTasks[0].ProgressPriority.Value != contracts.TaskPriorityHigh {
		t.Fatal("priority not persisted")
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPost, "/api/tasks/clear-completed", `{}`), 200)
	if len(app.store.Snapshot().WorkTasks) != 1 || app.store.Snapshot().WorkTasks[0].ProgressDismissedAt.Present {
		t.Fatal("unfinished progress was cleared as completed")
	}
	for _, route := range []string{"/api/stop", "/api/tasks/pause"} {
		requireWorkerStatus(t, callWorker(app, http.MethodPost, route, `{}`), 200)
	}
	for _, test := range []struct {
		route, body string
		status      int
	}{
		{"/api/retry/missing", `{}`, 409},
		{"/api/retry/missing", `{`, 400},
		{"/api/tasks/resume", `{`, 400},
		{"/api/tasks/resume", `{"ids":null}`, 400},
		{"/api/tasks/resume", `{"ids":[],"confirmUnknown":"yes"}`, 400},
		{"/api/tasks/missing/accept", `{}`, 404},
		{"/api/tasks/current/pause", `{`, 400},
		{"/api/tasks/current/cancel", `{"kind":"other","turnId":null}`, 400},
		{"/api/tasks/not-current/cancel", `{"kind":"active","turnId":null}`, 400},
		{"/api/tasks/current/cancel", `{"kind":"active"}`, 400},
		{"/api/tasks/current/cancel", `{"kind":"active","turnId":false}`, 400},
		{"/api/tasks/current/cancel", `{"kind":"active","turnId":null,"callId":false}`, 400},
		{"/api/tasks/current/cancel", `{"kind":"active","turnId":null,"conversationId":"old"}`, 409},
		{"/api/tasks/current/cancel", `{"kind":"active","turnId":null}`, 409},
		{"/api/tasks/" + record.ID + "/resume", `{`, 400},
		{"/api/tasks/" + record.ID + "/resume", `{"kind":"invalid"}`, 400},
		{"/api/tasks/" + record.ID + "/resume", `{"kind":"work","turnId":null}`, 409},
		{"/api/tasks/" + record.ID + "/resume", `{"kind":"work","turnId":"` + record.TurnID + `"}`, 409},
		{"/api/tasks/" + record.ID + "/priority", `{`, 400},
		{"/api/tasks/" + record.ID + "/priority", `{"kind":"invalid","priority":"high"}`, 400},
		{"/api/tasks/" + record.ID + "/priority", `{"kind":"work","priority":false}`, 400},
		{"/api/tasks/" + record.ID + "/dismiss", `{`, 400},
		{"/api/tasks/" + record.ID + "/dismiss", `{"kind":"invalid"}`, 400},
		{"/api/tasks/" + record.ID + "/dismiss", `{"kind":"work","confirmUnfinished":"yes"}`, 400},
		{"/api/tasks/" + record.ID + "/dismiss", `{"kind":"work","expectedTurnId":1}`, 400},
		{"/api/tasks/" + record.ID + "/dismiss", `{"kind":"work","expectedConversationId":"\ud800"}`, 400},
		{"/api/steer", `{`, 400},
		{"/api/steer", `{"text":false}`, 400},
		{"/api/steer", `{"text":"fixture","expectedTurnId":"\ud800"}`, 400},
		{"/api/steer", `{"text":"fixture","expectedTurnId":"turn","replyTo":false}`, 400},
		{"/api/steer", `{"text":"fixture","expectedTurnId":"turn","conversationId":"old"}`, 409},
		{"/api/steer", `{"text":"fixture","expectedTurnId":"turn"}`, 409},
		{"/api/takeover", `{`, 400},
		{"/api/takeover", `{"enabled":"yes"}`, 400},
		{"/api/takeover", `{"enabled":false}`, 400},
		{"/api/takeover", `{"enabled":false,"sessionId":"old"}`, 409},
		{"/api/takeover", `{"enabled":true}`, 409},
		{"/api/input", `{`, 400},
		{"/api/input", `{"type":"click"}`, 409},
	} {
		t.Run(test.route+"/"+test.body, func(t *testing.T) {
			before := app.store.Snapshot()
			requireWorkerStatus(t, callWorker(app, http.MethodPost, test.route, test.body), test.status)
			if !reflect.DeepEqual(before, app.store.Snapshot()) {
				t.Fatal("rejected progress request changed task ownership")
			}
		})
	}
	response := callWorker(app, http.MethodGet, "/api/screen", "")
	requireWorkerStatus(t, response, 500)
	var status struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(response.Body.Bytes(), &status) != nil || status.Error == nil {
		t.Fatal("unavailable screen did not retain explicit error")
	}
}
