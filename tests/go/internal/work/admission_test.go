package work

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/history"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
)

const admissionClientID = "f9c16002-17a4-4dd0-8e23-06203631ac51"

func TestClientMessageDeduplicationPreservesDistinctLegacyUTF16Units(t *testing.T) {
	engine, persistence, _ := engineFixture(t)
	reservation, err := engine.ReserveCallStart(context.Background(), "handshake", "subscription")
	if err != nil {
		t.Fatal(err)
	}
	defer engine.ReleaseCallStart(reservation)
	var first, other contracts.ChatMessage
	if json.Unmarshal([]byte(`{"role":"user","text":"legacy\ud800","clientMessageId":"`+admissionClientID+`"}`), &first) != nil || json.Unmarshal([]byte(`{"role":"user","text":"legacy\ud801","clientMessageId":"`+admissionClientID+`"}`), &other) != nil {
		t.Fatal("invalid fixture")
	}
	if _, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &first); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &other); err == nil {
		t.Fatal("distinct surrogate content was treated as the same request")
	}
	if receipt, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &first); err != nil || !receipt.Existing {
		t.Fatal("exact legacy duplicate was not retained", err)
	}
}

func TestMessageAdmissionDeduplicatesConcurrentClientRequestsBeforeQueueing(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	reservation, err := engine.ReserveCallStart(context.Background(), "call-handshake", "subscription")
	if err != nil {
		t.Fatal(err)
	}
	defer engine.ReleaseCallStart(reservation)

	conversationID := persistence.ConversationID()
	const requestCount = 16
	start := make(chan struct{})
	results := make(chan AdmissionReceipt, requestCount)
	errorsFound := make(chan error, requestCount)
	var requests sync.WaitGroup
	for range requestCount {
		requests.Add(1)
		go func() {
			defer requests.Done()
			<-start
			receipt, err := engine.AdmitMessage(context.Background(), conversationID, &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "one request", ClientMessageID: admissionClientID,
			})
			results <- receipt
			errorsFound <- err
		}()
	}
	close(start)
	requests.Wait()
	close(results)
	close(errorsFound)

	for err := range errorsFound {
		if err != nil {
			t.Fatal(err)
		}
	}
	created := 0
	messageID := ""
	for receipt := range results {
		if receipt.Message == nil {
			t.Fatal("admission omitted the durable message")
		}
		if messageID != "" && receipt.Message.ID != messageID {
			t.Fatal("one client identity created multiple server messages")
		}
		messageID = receipt.Message.ID
		if !receipt.Existing {
			created++
		}
	}
	if created != 1 || len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("duplicate requests changed durable history")
	}
	if queue := engine.Snapshot().Queue; len(queue) != 1 || queue[0] != messageID {
		t.Fatal("duplicate requests changed execution admission")
	}
	select {
	case <-worker.requests:
		t.Fatal("a call handshake reservation allowed another execution")
	default:
	}

	_, err = engine.AdmitMessage(context.Background(), conversationID, &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "different request", ClientMessageID: admissionClientID,
	})
	var conflict *contracts.APIError
	if !errors.As(err, &conflict) || conflict.Status != 409 {
		t.Fatal("conflicting duplicate input was accepted")
	}
}

func TestHistoryClearAndLateDuplicateCannotRestoreDeletedInput(t *testing.T) {
	engine, persistence, _ := engineFixture(t)
	reservation, err := engine.ReserveCallStart(context.Background(), "call-handshake", "subscription")
	if err != nil {
		t.Fatal(err)
	}
	defer engine.ReleaseCallStart(reservation)

	conversationID := persistence.ConversationID()
	input := &contracts.ChatMessage{Role: contracts.RoleUser, Text: "remove this request", ClientMessageID: admissionClientID}
	if _, err := engine.AdmitMessage(context.Background(), conversationID, input); err != nil {
		t.Fatal(err)
	}
	historyService := history.New(persistence, engine.HistoryTransaction)
	start := make(chan struct{})
	var requests sync.WaitGroup
	requests.Add(2)
	go func() {
		defer requests.Done()
		<-start
		if _, err := historyService.Clear(context.Background(), true); err != nil {
			t.Error(err)
		}
	}()
	go func() {
		defer requests.Done()
		<-start
		_, err := engine.AdmitMessage(context.Background(), conversationID, input)
		var conflict *contracts.APIError
		if err != nil && (!errors.As(err, &conflict) || conflict.Code != "message_deleted") {
			t.Error(err)
		}
	}()
	close(start)
	requests.Wait()

	if len(persistence.Snapshot().Messages) != 0 || len(engine.Snapshot().Queue) != 0 {
		t.Fatal("history clear lost its execution/history fence")
	}
	if _, err := engine.AdmitMessage(context.Background(), conversationID, input); err == nil {
		t.Fatal("a delayed request recreated deleted input")
	}
	if _, err := engine.AdmitMessage(context.Background(), "another-conversation", &contracts.ChatMessage{Role: contracts.RoleUser, Text: "wrong scope"}); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("stale conversation entered current history")
	}
}

type admissionCalls struct{ call contracts.Call }

func (value *admissionCalls) Start(context.Context, contracts.RawObject) (contracts.Call, error) {
	return value.call, nil
}

func (value *admissionCalls) Stop(context.Context, string) error { return nil }
func (value *admissionCalls) Snapshot() *contracts.Call {
	copy := value.call
	return &copy
}

func (*admissionCalls) OwnsEvent(runtime.Event) bool                     { return false }
func (*admissionCalls) HandleEvent(context.Context, runtime.Event) error { return nil }
func (*admissionCalls) PauseWork(context.Context) error                  { return nil }
func (*admissionCalls) PendingWork() bool                                { return false }

func TestInteractiveCallAdmissionPreservesCapturedCallWithoutStartingAnotherTurn(t *testing.T) {
	for _, provider := range []string{"api", "subscription"} {
		t.Run(provider, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			engine.options.Calls = &admissionCalls{call: contracts.Call{ID: "captured-call", Provider: provider}}

			receipt, err := engine.AdmitMessage(context.Background(), persistence.ConversationID(), &contracts.ChatMessage{
				Role: contracts.RoleUser, Text: "say this in this call", ClientMessageID: admissionClientID,
			})
			if err != nil {
				t.Fatal(err)
			}
			if receipt.CallID != "captured-call" || receipt.Provider != provider || receipt.Queued || receipt.SteerTurnID != "" {
				t.Fatal("interactive input was routed to a different execution owner")
			}
			if len(persistence.Snapshot().Messages) != 1 || len(engine.Snapshot().Queue) != 0 {
				t.Fatal("call input was not persisted once independently of task admission")
			}
			select {
			case <-worker.requests:
				t.Fatal("call input started another task turn")
			default:
			}
		})
	}
}
