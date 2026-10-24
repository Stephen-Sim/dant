package runtime

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func streamDelta(text string) Event {
	encoded, _ := json.Marshal(text)
	return Event{Method: "item/agentMessage/delta", Params: contracts.RawObject{
		"threadId": json.RawMessage(`"thread"`), "turnId": json.RawMessage(`"turn"`),
		"itemId": json.RawMessage(`"item"`), "delta": encoded,
	}}
}

func queueSubscription() *eventSubscription {
	return &eventSubscription{channel: make(chan Event, RPCEventQueue)}
}

func TestRPCBurstDeltasPreserveResponseAndTerminalEvidenceForAnUndrainedObserver(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		events, unsubscribe, err := fixture.client.SubscribeEvents()
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribe()
		answered := make(chan error, 1)
		go func() {
			_, err := fixture.client.Request(t.Context(), "thread/read", nil)
			answered <- err
		}()
		request := rpcMethod(t, fixture, "thread/read")
		const count = 4096
		for range count {
			fixture.send(t, `{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"item","delta":"line 😀\n"}}`)
		}
		fixture.send(t, `{"method":"item/completed","params":{"item":{"id":"item","type":"agentMessage","text":"final"}}}`)
		fixture.send(t, `{"method":"turn/completed","params":{"turn":{"id":"turn","status":"completed"}}}`)
		replyFixture(t, fixture, request, `{}`)
		if err := <-answered; err != nil || fixture.client.Closed() {
			t.Fatal("an undrained text observer blocked its correlated RPC response", err)
		}
		if err := fixture.output.Close(); err != nil {
			t.Fatal(err)
		}
		// EOF must join the dispatcher without waiting for this subscriber.
		<-fixture.client.Done()
		var text strings.Builder
		terminal := 0
		observed := 0
		for event := range events {
			observed++
			switch event.Method {
			case "item/agentMessage/delta":
				if terminal != 0 {
					t.Fatal("text crossed an item or turn completion barrier")
				}
				var delta string
				if json.Unmarshal(event.Params["delta"], &delta) != nil {
					t.Fatal("invalid merged text")
				}
				text.WriteString(delta)
			case "item/completed":
				if terminal != 0 {
					t.Fatal("item completion was duplicated or reordered")
				}
				terminal = 1
			case "turn/completed":
				if terminal != 1 {
					t.Fatal("turn completion lost its preceding item evidence")
				}
				terminal = 2
			}
		}
		if text.String() != strings.Repeat("line 😀\n", count) || terminal != 2 || observed > 4 {
			t.Fatal("burst delivery lost text, terminal evidence, or its bounded coalescing", observed)
		}
		if fixture.client.closureReason() != DisconnectEOF {
			t.Fatal("ordinary text throughput retired a healthy executor")
		}
	})
}

func TestEventQueueMergesOnlyAdjacentExactOwnedDeltaEnvelopes(t *testing.T) {
	for _, barrier := range []Event{
		{Method: "item/completed", Params: contracts.RawObject{"item": json.RawMessage(`{"id":"item"}`)}},
		{Method: "item/tool/call", ID: contracts.Some(NumericRPCID(9)), Params: contracts.RawObject{}},
		func() Event {
			event := streamDelta("barrier")
			event.Params["turnId"] = json.RawMessage(`"other-turn"`)
			return event
		}(),
		func() Event {
			event := streamDelta("barrier")
			event.Params["threadId"] = json.RawMessage(`"other-thread"`)
			return event
		}(),
		func() Event {
			event := streamDelta("barrier")
			event.Params["itemId"] = json.RawMessage(`"other-item"`)
			return event
		}(),
		func() Event {
			event := streamDelta("barrier")
			event.Params["phase"] = json.RawMessage(`"commentary"`)
			return event
		}(),
		func() Event {
			event := streamDelta("barrier")
			event.ID = contracts.Null[RPCID]()
			return event
		}(),
		func() Event {
			event := streamDelta("barrier")
			event.Projection = ObserverProjectionPayload
			return event
		}(),
		func() Event {
			event := streamDelta("barrier")
			event.TaskExecutionObserved = true
			return event
		}(),
		func() Event {
			event := streamDelta("barrier")
			event.MediaCallID = contracts.Some("call")
			return event
		}(),
	} {
		t.Run(barrier.Method+string(barrier.Projection), func(t *testing.T) {
			subscription := queueSubscription()
			for _, event := range []Event{streamDelta("first"), streamDelta(" second"), barrier, streamDelta("last")} {
				if !subscription.enqueue(event) {
					t.Fatal("small ordered fixture exceeded its budget")
				}
			}
			subscription.close()
			var events []Event
			for event := range subscription.channel {
				events = append(events, event)
			}
			if len(events) != 3 || events[1].Method != barrier.Method ||
				string(events[0].Params["delta"]) != `"first second"` ||
				string(events[2].Params["delta"]) != `"last"` {
				t.Fatal("coalescing crossed lifecycle, identity, request, or metadata barriers")
			}
		})
	}
}

func TestEventQueuePreservesUTF16AndNeverMutatesSharedOrPublishedEvents(t *testing.T) {
	left, right := streamDelta(""), streamDelta("")
	left.Params["delta"] = json.RawMessage(`"\ud83d"`)
	right.Params["delta"] = json.RawMessage(`"\ude00"`)
	first, second := queueSubscription(), queueSubscription()
	if !first.enqueue(left) || !second.enqueue(left) || !first.enqueue(right) {
		t.Fatal("valid UTF-16 fragments were rejected")
	}
	first.close()
	second.close()
	merged, original := <-first.channel, <-second.channel
	units, err := contracts.DecodeJSONTextUnits(merged.Params["delta"])
	if err != nil || len(units) != 2 || units[0] != 0xd83d || units[1] != 0xde00 ||
		string(left.Params["delta"]) != `"\ud83d"` || string(original.Params["delta"]) != `"\ud83d"` {
		t.Fatal("text merging repaired code units or mutated another observer's event", err)
	}
	merged.Params["itemId"][1] = 'x'
	if string(original.Params["itemId"]) != `"item"` || string(left.Params["itemId"]) != `"item"` {
		t.Fatal("subscriber metadata retained a shared mutable alias")
	}

	active := queueSubscription()
	if !active.enqueue(streamDelta("published")) {
		t.Fatal("first event rejected")
	}
	active.dispatch()
	if !active.enqueue(streamDelta("private")) || !active.enqueue(streamDelta(" tail")) {
		t.Fatal("private text rejected")
	}
	active.close()
	if string((<-active.channel).Params["delta"]) != `"published"` ||
		string((<-active.channel).Params["delta"]) != `"private tail"` {
		t.Fatal("coalescing changed an immutable event already published to a channel")
	}
}

func TestEventQueueDoesNotMergeMissingInvalidOrForeignIdentityFields(t *testing.T) {
	for _, key := range []string{"threadId", "turnId", "itemId"} {
		for _, invalid := range []json.RawMessage{nil, json.RawMessage(`""`), json.RawMessage(`"\ud800"`), json.RawMessage(`7`)} {
			subscription := queueSubscription()
			event := streamDelta("retained")
			if invalid == nil {
				delete(event.Params, key)
			} else {
				event.Params[key] = invalid
			}
			if !subscription.enqueue(event) || !subscription.enqueue(event) {
				t.Fatal("identity-invalid observations were not retained for their owning validator")
			}
			subscription.close()
			if len(subscription.channel) != 2 {
				t.Fatal("missing or invalid identity authorized text merging", key)
			}
		}
	}
	for _, invalid := range []json.RawMessage{json.RawMessage(`null`), json.RawMessage(`1`)} {
		subscription := queueSubscription()
		event := streamDelta("")
		event.Params["delta"] = invalid
		if !subscription.enqueue(event) || !subscription.enqueue(event) {
			t.Fatal("non-text observations displaced existing evidence")
		}
		subscription.close()
		if len(subscription.channel) != 2 {
			t.Fatal("non-text observations were interpreted as appendable text")
		}
	}
}

func TestRPCDispatcherBoundsConsumerWakeLatencyAndUnsubscribeDoesNotStopRPC(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		events, unsubscribe, err := fixture.client.SubscribeEvents()
		if err != nil {
			t.Fatal(err)
		}
		for range 3 {
			if !fixture.client.emit(Event{Method: "fixture/control"}) {
				t.Fatal("small control fixture overflowed")
			}
		}
		synctest.Wait()
		<-events
		started := time.Now()
		<-events
		if time.Since(started) > eventDispatchDelay {
			t.Fatal("a consuming observer waited beyond the bounded dispatch delay")
		}
		// One undrained event must be retained while unsubscribe finishes immediately.
		unsubscribe()
		unsubscribe()
		if _, open := <-events; !open {
			t.Fatal("unsubscribe discarded already received control evidence")
		}
		if _, open := <-events; open || fixture.client.Closed() {
			t.Fatal("unsubscribe kept its channel open or disconnected an unrelated RPC")
		}
		if !fixture.client.emit(Event{Method: "fixture/later"}) {
			t.Fatal("an unsubscribed slow observer remained attached")
		}
	})
}

func TestEventQueueBoundsMergedTextAndTotalBytesWithoutTruncation(t *testing.T) {
	subscription := queueSubscription()
	text := strings.Repeat("x", ObserverAgentTextChars)
	if !subscription.enqueue(streamDelta(text)) || !subscription.enqueue(streamDelta("tail")) {
		t.Fatal("a full text segment prevented bounded subsequent delivery")
	}
	subscription.close()
	var observed string
	count := 0
	for event := range subscription.channel {
		var delta string
		_ = json.Unmarshal(event.Params["delta"], &delta)
		observed += delta
		count++
	}
	if count != 2 || observed != text+"tail" {
		t.Fatal("a merge budget silently discarded text")
	}

	bounded := queueSubscription()
	payload, _ := json.Marshal(strings.Repeat("b", RPCEventQueueBytes/2))
	event := Event{Method: "fixture/bounded", Params: contracts.RawObject{"payload": payload}}
	if !bounded.enqueue(event) || bounded.enqueue(event) {
		t.Fatal("aggregate payload bytes were unbounded independently of event count")
	}
	bounded.close()
	if len((<-bounded.channel).Params["payload"]) != len(payload) {
		t.Fatal("an admitted large observer frame was truncated")
	}
}

func TestRPCConcurrentCloseAndUnsubscribeRetainBufferedControlsWithoutConsumer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := newRPCFixture(t)
		events, unsubscribe, err := fixture.client.SubscribeEvents()
		if err != nil {
			t.Fatal(err)
		}
		for range RPCEventQueue {
			if !fixture.client.emit(Event{Method: "fixture/control"}) {
				t.Fatal("bounded control evidence was rejected before capacity")
			}
		}
		var joined sync.WaitGroup
		for range 8 {
			joined.Go(fixture.client.Close)
			joined.Go(unsubscribe)
		}
		joined.Wait()
		<-fixture.client.Done()
		count := 0
		for range events {
			count++
		}
		if count != RPCEventQueue {
			t.Fatal("shutdown lost control evidence or waited for a stopped subscriber", count)
		}
	})
}
