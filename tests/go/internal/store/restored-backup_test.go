package store

import (
	"bytes"
	"encoding/json"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"testing"
)

func TestBackupPreparationRetainsLegacyContentAndFencesAllUnfinishedExecution(t *testing.T) {
	raw := []byte(`{"conversationId":"49954ce5-c8c5-4f6e-a7d8-531530d09479","settings":{},"threadId":"thread-old","threadRuntime":"vm:old","threadConversationId":"old","messages":[{"id":"user","role":"user","text":"legacy\ud800","time":17,"status":"running"},{"id":"uncertain","role":"user","status":"queued","submission":"submitting"},{"id":"assistant","role":"assistant","status":"streaming"},{"id":"done","role":"user","status":"completed"}],"workTasks":[{"id":"49954ce5-c8c5-4f6e-a7d8-531530d09479","turnId":"turn","turnIds":["turn"],"title":"work","status":"continuing","source":"chat","startedAt":8,"updatedAt":9,"plan":null,"continuation":{"nextAt":20,"attempts":1,"noProgressCount":0,"lastCheckpoint":"checkpoint","dispatch":{"id":"attempt","fromTurnId":"turn","runtimeId":"vm:old","threadId":"thread-old","phase":"submitting","createdAt":9}}}],"completions":[],"unknownRoot":{"preserved":true},"callInputHistory":[{"submission":"pending"}]}`)
	prepared, err := PauseRestoredState(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(prepared, []byte(`"text":"legacy\ud800"`)) {
		t.Fatal("legacy UTF-16 text changed")
	}
	var state contracts.State
	if err = json.Unmarshal(prepared, &state); err != nil {
		t.Fatal(err)
	}
	if !state.ThreadID.Null || !state.ThreadRuntime.Null || state.ThreadConversationID != "" {
		t.Fatal("execution thread retained")
	}
	if state.Messages[0].Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || state.Messages[0].Time.Value != 17 {
		t.Fatal("known running task not paused or timestamp changed")
	}
	if !state.Messages[1].UnknownOutcome || state.Messages[1].Submission.Value != contracts.SubmissionStatusUnknown {
		t.Fatal("unknown submission became replayable")
	}
	if state.Messages[2].Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) || state.Messages[3].Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) {
		t.Fatal("assistant/terminal recovery changed")
	}
	if state.WorkTasks[0].Status != contracts.WorkStatusUnknown || !state.WorkTasks[0].Continuation.NextAt.Null || state.WorkTasks[0].UpdatedAt != 9 {
		t.Fatal("continuation recovery did not fence its existing owner")
	}
	if _, exists := state.Extra["unknownRoot"]; !exists {
		t.Fatal("legacy extension lost")
	}
}

func TestBackupValidationNeverInventsIdentityOrSilentlySkipsInvalidMessages(t *testing.T) {
	for _, raw := range []string{`{"settings":{},"messages":[],"workTasks":[],"completions":[]}`, `{"conversationId":"49954ce5-c8c5-4f6e-a7d8-531530d09479","settings":{},"messages":[{"id":"a","role":"unexpected"}],"workTasks":[],"completions":[]}`} {
		if _, err := PauseRestoredState([]byte(raw)); err == nil {
			t.Fatal("invalid restore accepted")
		}
	}
}
