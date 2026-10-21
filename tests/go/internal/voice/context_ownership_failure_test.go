package voice

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAPILiveMemoryRejectsMalformedSnapshotsWithoutReplacingCommittedContext(t *testing.T) {
	api, session, socket := eventOnlyAPIFixture(t)
	session.baseMemory = "Previously acknowledged memory"
	session.contextEntries = map[string]string{"message:retained": "Previously acknowledged reference"}
	session.contextOrder = []string{"message:retained"}

	err := api.sendContext(t.Context(), session, ContextInput{Kind: "memory", Key: "memory", Text: `{"memory":`, ContextID: "invalid-memory"})
	if !errors.Is(err, ErrContextRejected) || socket.count("session.update") != 0 || session.contextAck != nil {
		t.Fatal("malformed memory snapshot crossed transport or retained a pending acknowledgement", err)
	}
	if session.baseMemory != "Previously acknowledged memory" || session.contextEntries["message:retained"] != "Previously acknowledged reference" || len(session.contextOrder) != 1 {
		t.Fatal("rejected memory replaced previously acknowledged context")
	}
}

func TestAPILiveContextQueueFailureIsNotReportedAsSubmitted(t *testing.T) {
	api, session, socket := eventOnlyAPIFixture(t)
	api.options.ContextTimeout = time.Nanosecond
	message := &contracts.ChatMessage{ID: "reference", Role: contracts.RoleAssistant, Text: "Existing result"}

	for _, result := range []ContextResult{
		api.SyncMemory(t.Context(), session.callID, "New memory"),
		api.SyncContext(t.Context(), session.callID, "message", message),
	} {
		if result.Status != contracts.LiveContextStatusFailed || result.CallID != session.callID {
			t.Fatal("unavailable context queue returned a successful acknowledgement", result)
		}
	}
	if session.contextQueue != nil || socket.count("session.update") != 0 {
		t.Fatal("invalid queue submitted context or retained an unowned worker")
	}
}

func TestAPICallCancellationReleasesItsOwnPendingContextWithoutCommittingIt(t *testing.T) {
	api, session, socket := eventOnlyAPIFixture(t)
	session.baseMemory = "Acknowledged memory"
	session.contextEntries = map[string]string{}
	socket.respond = func(event contracts.RawObject) {
		if textField(event, "type") == "session.update" {
			session.cancel()
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()

	err := api.sendContext(ctx, session, ContextInput{Kind: "memory", Key: "memory", Text: string(rawValue("Unacknowledged memory")), ContextID: "cancelled-context"})
	if !errors.Is(err, ErrVoiceCancelled) || session.contextAck != nil || session.baseMemory != "Acknowledged memory" || socket.count("session.update") != 1 {
		t.Fatal("cancelled call committed or retried its unacknowledged context", err)
	}
}
