package app

import (
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

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/updates"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestWorkerDefaultHostGuardRejectsAnUnverifiedHostBeforePersistence(t *testing.T) {
	options := fixtureWorkerOptions(t)
	options.VerifyHost = nil
	t.Setenv("PATH", t.TempDir())
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	app, err := NewWorker(ctx, options)
	if app != nil || (!errors.Is(err, workerRuntime.ErrWorkerRole) && !errors.Is(err, workerRuntime.ErrVMUnavailable)) {
		if app != nil {
			app.Close()
		}
		t.Fatal("default host verification admitted an unverified execution host", err)
	}
	if _, err := os.Stat(filepath.Join(options.Startup.DataDir, "state.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("host rejection created authoritative conversation state")
	}
}

func TestWorkerReadOnlyUpdateMetadataReturnsItsValidatedFakeRelease(t *testing.T) {
	options := fixtureWorkerOptions(t)
	requests := 0
	options.UpdateHTTP = appHTTPFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Host != "api.github.com" || request.Header.Get("Authorization") != "" {
			t.Error("public update check sent a credential or changed its fixed authority")
		}
		release := `{"tag_name":"v1.2.3","draft":false,"prerelease":false,"html_url":"` + updates.ReleasesURL + `/tag/v1.2.3","published_at":"2026-10-19T12:00:00Z","assets":[]}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(release))}, nil
	})
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	for range 2 {
		response := callWorker(app, http.MethodGet, "/api/updates?channel=stable", "")
		requireWorkerStatus(t, response, http.StatusOK)
		var result updates.CheckResult
		if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.LatestVersion != "1.2.3" || !result.UpdateAvailable || result.ReleaseURL != updates.ReleasesURL+"/tag/v1.2.3" {
			t.Fatal("validated update metadata was not returned")
		}
	}
	if requests != 1 || len(app.store.Snapshot().Messages) != 0 || app.worker.Snapshot().Status != contracts.ConnectionStatusOffline {
		t.Fatal("read-only update lookup repeated a network request or started execution")
	}
}

func TestWorkerRetiredFileOwnerCannotPersistAnAttachment(t *testing.T) {
	app, wire, owner := acknowledgedToolFixture(t)
	file := filepath.Join(t.TempDir(), "retained.txt")
	if err := os.WriteFile(file, []byte("retained local output"), 0600); err != nil {
		t.Fatal(err)
	}
	checks := 0
	owner.IsCurrent = func() bool {
		checks++
		return checks == 1
	}
	before := app.store.Revision()
	if _, err := app.fileTool(t.Context(), "send_file", contracts.RawObject{"path": encode(file)}, owner); err == nil {
		t.Fatal("retired file owner reported a confirmed delivery")
	}
	if checks < 2 || app.store.Revision() != before || wire.count("turn/start") != 1 {
		t.Fatal("archive ownership was not rechecked or failed output started another turn")
	}
}

func TestWorkerInvalidScheduleSaveRemainsAReadOnlyFailure(t *testing.T) {
	app := fixtureWorker(t)
	before := app.store.Revision()
	response := callWorker(app, http.MethodPost, "/api/schedules", `{}`)
	requireWorkerStatus(t, response, http.StatusBadRequest)
	if !strings.Contains(response.Body.String(), `"code":"invalid_schedule"`) || app.store.Revision() != before || len(app.store.Snapshot().Schedules) != 0 {
		t.Fatal("invalid schedule save mutated another task or lost its input classification")
	}
}

func TestWorkerAssembledChangeCallbackAndUnavailableSkillIndexRemainBounded(t *testing.T) {
	var changes atomic.Int32
	app, wire := connectedWorkerFixture(t, func(options *WorkerOptions) {
		options.WorkerOptions.Changed = func() {
			changes.Add(1)
		}
	})
	if changes.Load() == 0 {
		t.Fatal("Worker assembly discarded its supplied change callback")
	}
	workspace := filepath.Join(app.options.Startup.WorkspaceRoot, app.store.ConversationID())
	if err := os.Rename(workspace, workspace+"-retained"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(workspace, []byte("occupied isolated skills workspace"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := app.worker.Request(t.Context(), "turn/steer", contracts.RawObject{}); err != nil {
		t.Fatal("unavailable optional skill index failed an otherwise valid request", err)
	}
	if wire.count("turn/steer") != 1 || len(app.store.Snapshot().Messages) != 0 {
		t.Fatal("skill-index fallback repeated a request or invented a chat input")
	}
}

func TestWorkerCallReactionAndNewAttachmentKeepTheirExactMessageIdentity(t *testing.T) {
	app, socket, callID, _ := activeAPICallFixture(t)
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "react to this existing response"})
	if err != nil {
		t.Fatal(err)
	}
	response := callWorker(app, http.MethodPost, "/api/messages/"+message.ID+"/reaction", `{"emoji":"👍","conversationId":"`+app.store.ConversationID()+`"}`)
	requireWorkerStatus(t, response, http.StatusOK)
	var reaction struct {
		OK           bool `json:"ok"`
		VoiceContext struct {
			Status contracts.LiveContextStatus `json:"status"`
		} `json:"voiceContext"`
	}
	if json.Unmarshal(response.Body.Bytes(), &reaction) != nil || !reaction.OK || reaction.VoiceContext.Status != contracts.LiveContextStatusSubmitted {
		t.Fatal("reaction did not synchronize with its current fake call")
	}
	file, err := app.attachments.Put(t.Context(), "isolated.txt", "text/plain", []byte("saved attachment bytes"))
	if err != nil {
		t.Fatal(err)
	}
	clientID := "1710df38-7949-4786-8a33-137aa5629e39"
	response = callWorker(app, http.MethodPost, "/api/messages", `{"text":"inspect saved attachment","clientMessageId":"`+clientID+`","attachments":["`+file.ID+`"]}`)
	requireWorkerStatus(t, response, http.StatusOK)
	var accepted contracts.ChatMessage
	if json.Unmarshal(response.Body.Bytes(), &accepted) != nil || accepted.ID == "" || accepted.ClientMessageID != clientID || len(accepted.Attachments) != 1 || accepted.Attachments[0].ID != file.ID {
		t.Fatal("new attachment admission lost stable file or client identity")
	}
	if call := app.calls.Snapshot(); call == nil || call.ID != callID || socket.count("session.update") < 2 {
		t.Fatal("message context changed call ownership or omitted synchronization")
	}
}

func TestWorkerCallReplyMemoryFailureIsKnownUnsentAndNeverReplayed(t *testing.T) {
	app, socket, callID, _ := activeAPICallFixture(t)
	prior, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "existing reply target"})
	if err != nil {
		t.Fatal(err)
	}
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "new call reply", ClientMessageID: "isolated-reply-client", ReplyTo: contracts.Some(prior.ID),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := app.memory.Close(); err != nil {
		t.Fatal(err)
	}
	before := socket.count("conversation.item.create")
	err = app.sendAcceptedCallMessage(t.Context(), app.store.ConversationID(), work.AdmissionReceipt{Message: message, CallID: callID})
	if err == nil {
		t.Fatal("unavailable memory was reported as confirmed call delivery")
	}
	saved, err := app.store.Message(message.ID)
	if err != nil || saved.Submission.Value != contracts.SubmissionStatusNotSubmitted || saved.ReplyTo.Value != prior.ID || socket.count("conversation.item.create") != before {
		t.Fatal("known-unsent call input was replayed or lost its reply identity", err)
	}
}

func TestWorkerValidWorkReplyIsScopedBeforeAdmission(t *testing.T) {
	app := fixtureWorker(t)
	conversation := app.store.ConversationID()
	response := callWorker(app, http.MethodPost, "/api/messages", string(encode(contracts.RawObject{
		"text": encode("reference a retired task"),
		"workReply": encode(contracts.RawObject{
			"workId": encode("missing-work"), "turnId": encode("captured-turn"), "conversationId": encode(conversation),
		}),
	})))
	requireWorkerStatus(t, response, http.StatusConflict)
	if len(app.store.Snapshot().Messages) != 0 || len(app.engine.Snapshot().Queue) != 0 {
		t.Fatal("a well-formed retired task reference started replacement work")
	}
	failure := conversationRouteError(store.ErrInvalidState)
	var api *contracts.APIError
	if !errors.As(failure, &api) || api.Status != http.StatusBadRequest || api.Code != "invalid_message" {
		t.Fatal("invalid stored message was not exposed as a bounded input failure")
	}
}
