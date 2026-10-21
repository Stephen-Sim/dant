package voice

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestVoiceServiceWithoutProvidersRetainsOrdinaryWorkAndRejectsMediaRequests(t *testing.T) {
	service := NewService(ServiceOptions{})
	owner := work.ContinuationOwner{ConversationID: "conversation", ThreadID: "thread", WorkID: "work"}
	if service.Snapshot() != nil || service.PendingWork() || !service.CanContinueWhileIdle(owner) || service.APIState().Call != nil || service.NativeState().Model != NativeRealtimeModel {
		t.Fatal("missing media provider invented an active call or blocked ordinary work")
	}
	admission, err := service.BeginContinuationAdmission(owner)
	if err != nil || admission.Owner != owner || admission.CallID != "" {
		t.Fatal("ordinary continuation acquired nonexistent media", admission, err)
	}
	if err := service.ConfirmContinuationAdmission(admission, "turn"); err != nil {
		t.Fatal(err)
	}
	events := []runtime.Event{{Method: "fixture/event"}}
	retained, conflict, err := service.ReplayContinuationEvents(t.Context(), admission, events, "turn", false)
	if err != nil || conflict || len(retained) != 1 {
		t.Fatal("ordinary continuation lost its event buffer", retained, conflict, err)
	}
	service.FinishContinuationAdmission(admission)
	if service.OwnsEvent(events[0]) || service.HandleEvent(t.Context(), events[0]) != nil || service.PauseWork(t.Context()) != nil || service.Stop(t.Context(), "absent") != nil || service.Close(t.Context()) != nil {
		t.Fatal("absent media provider attempted work or failed idempotent shutdown")
	}
	if _, err := service.Voices(t.Context()); !errors.Is(err, ErrVoiceConnection) {
		t.Fatal("unavailable provider invented supported voices", err)
	}
	if _, err := service.Message(t.Context(), MessageOptions{}); !errors.Is(err, ErrCallInput) {
		t.Fatal("nil typed input accepted", err)
	}
	if _, err := service.Message(t.Context(), MessageOptions{Message: &contracts.ChatMessage{ID: "message", Role: contracts.RoleUser, Text: "request"}}); !errors.Is(err, ErrVoiceCancelled) {
		t.Fatal("message reached absent media", err)
	}
	if _, err := service.NativeMessage(t.Context(), NativeMessage{CallID: "missing"}); !errors.Is(err, ErrVoiceCancelled) {
		t.Fatal("native request reached absent media", err)
	}
	if result := service.SyncMemory(t.Context(), "missing", "context"); result.Status != contracts.LiveContextStatusCancelled {
		t.Fatal("missing call memory was treated as submitted")
	}
	if result := service.SyncContext(t.Context(), "missing", "message", nil); result.Status != contracts.LiveContextStatusCancelled {
		t.Fatal("missing call reference was treated as submitted")
	}
	if _, err := service.Start(t.Context(), contracts.RawObject{"sdp": json.RawMessage(`false`)}); !errors.Is(err, ErrCallInput) {
		t.Fatal("malformed start wrapper accepted", err)
	}
	if _, err := service.Start(t.Context(), contracts.RawObject{"sdp": json.RawMessage(`"offer"`), "provider": json.RawMessage(`"unknown"`)}); !errors.Is(err, ErrCallInput) {
		t.Fatal("unknown provider accepted", err)
	}
}

func TestVoiceServiceDelegatesNativeLiveReferencesAndContinuationOwnership(t *testing.T) {
	native, _, engine, _ := nativeFixture(t)
	service := NewService(ServiceOptions{})
	if err := service.AttachNative(nil); !errors.Is(err, ErrVoiceBusy) {
		t.Fatal("nil media provider was attached", err)
	}
	if err := service.AttachNative(native); err != nil {
		t.Fatal(err)
	}
	if err := service.AttachNative(native); !errors.Is(err, ErrVoiceBusy) {
		t.Fatal("media provider was swapped", err)
	}
	if err := service.AttachReservations(nil); !errors.Is(err, ErrVoiceBusy) {
		t.Fatal("nil reservation owner accepted", err)
	}
	if err := service.AttachReservations(engine); err != nil {
		t.Fatal(err)
	}
	if err := service.AttachReservations(engine); !errors.Is(err, ErrVoiceBusy) {
		t.Fatal("reservation owner was replaced", err)
	}
	call, err := service.Start(t.Context(), object(map[string]any{"sdp": fixtureSDP, "callId": "call-one"}))
	if err != nil || call.ID != "call-one" {
		t.Fatal("native service startup wrapper lost call ID", call, err)
	}
	if _, err := service.ConfirmConnected(call.ID); err != nil {
		t.Fatal(err)
	}
	message := &contracts.ChatMessage{ID: "reference", Role: contracts.RoleAssistant, Text: "shared result"}
	if result := service.SyncMemory(t.Context(), call.ID, "new durable context"); result.Status != contracts.LiveContextStatusSubmitted {
		t.Fatal("native memory reference was not delivered", result)
	}
	if result := service.SyncContext(t.Context(), call.ID, "message", message); result.Status != contracts.LiveContextStatusSubmitted {
		t.Fatal("native reference was not delivered", result)
	}
	if result := service.SyncContext(t.Context(), call.ID, "unknown", message); result.Status != contracts.LiveContextStatusFailed {
		t.Fatal("invalid reference entered native queue", result)
	}
	if result := native.SyncContext(t.Context(), "other", "message", message); result.Status != contracts.LiveContextStatusCancelled {
		t.Fatal("foreign call received reference", result)
	}
	if result := native.SyncMemory(t.Context(), "other", "memory"); result.Status != contracts.LiveContextStatusCancelled {
		t.Fatal("foreign call received memory", result)
	}
	owner := work.ContinuationOwner{ConversationID: engine.state.ConversationID(), ThreadID: "shared-thread", WorkID: "work"}
	if !service.CanContinueWhileIdle(owner) {
		t.Fatal("idle native media blocked continuation")
	}
	admission, err := service.BeginContinuationAdmission(owner)
	if err != nil {
		t.Fatal(err)
	}
	if _, conflict, err := service.ReplayContinuationEvents(t.Context(), admission, nil, "accepted-turn", false); err != nil || conflict {
		t.Fatal("native continuation buffer failed", conflict, err)
	}
	if err := service.ConfirmContinuationAdmission(admission, "accepted-turn"); err != nil {
		t.Fatal(err)
	}
	service.FinishContinuationAdmission(admission)
	if err := service.Stop(context.Background(), call.ID); err != nil {
		t.Fatal(err)
	}
}
