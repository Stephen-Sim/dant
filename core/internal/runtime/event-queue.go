package runtime

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	RPCEventQueueBytes = MaxRPCFrameBytes
	eventDispatchDelay = time.Millisecond
)

type queuedEvent struct {
	event Event
	units []uint16
	bytes int
}

// RPC.mu owns pending delivery and its byte accounting. Consumers only receive
// immutable events from channel; they never mutate the private queue.
type eventSubscription struct {
	channel      chan Event
	filter       func(Event) bool
	pending      []queuedEvent
	pendingBytes int
	outputBytes  int
}

func eventPayloadBytes(event Event) int {
	size := len(event.Method) + len(event.ID.Value.raw) + len(event.MediaCallID.Value)
	for key, value := range event.Params {
		size += len(key) + len(value)
	}
	return size
}

func mergeableDelta(event Event) ([]uint16, bool) {
	if event.Method != "item/agentMessage/delta" || event.ID.Present {
		return nil, false
	}
	for _, key := range []string{"threadId", "turnId", "itemId"} {
		var identity string
		if !contracts.ValidUnicodeJSON(event.Params[key]) ||
			json.Unmarshal(event.Params[key], &identity) != nil || !observerIdentity(identity) {
			return nil, false
		}
	}
	units, err := contracts.DecodeJSONTextUnits(event.Params["delta"])
	return units, err == nil && len(units) <= ObserverAgentTextChars
}

func sameDeltaEnvelope(left, right Event) bool {
	if left.Method != right.Method || left.ID.Present || right.ID.Present ||
		left.MediaCallID != right.MediaCallID || left.Projection != right.Projection ||
		left.TaskExecutionObserved != right.TaskExecutionObserved || len(left.Params) != len(right.Params) {
		return false
	}
	for key, value := range left.Params {
		other, exists := right.Params[key]
		if key != "delta" && (!exists || !bytes.Equal(value, other)) {
			return false
		}
	}
	return true
}

func prepareQueuedEvent(event Event) queuedEvent {
	event.Params = cloneObject(event.Params)
	result := queuedEvent{event: event, bytes: eventPayloadBytes(event)}
	if units, mergeable := mergeableDelta(event); mergeable {
		// Six JSON bytes per UTF-16 unit bounds escaping before lazy encoding.
		// The private accumulator never changes an event already sent to a channel.
		result.bytes += len(units)*6 + 2 - len(event.Params["delta"])
		result.units = units
		result.event.Params["delta"] = nil
	}
	return result
}

func (event queuedEvent) materialize() Event {
	if event.units != nil {
		event.event.Params["delta"] = contracts.EncodeJSONTextUnits(event.units)
	}
	return event.event
}

func (subscription *eventSubscription) enqueue(event Event) bool {
	if len(subscription.channel) == 0 {
		subscription.outputBytes = 0
	}
	queued := prepareQueuedEvent(event)
	if queued.units != nil && len(subscription.pending) > 0 {
		tail := &subscription.pending[len(subscription.pending)-1]
		additional := len(queued.units) * 6
		if tail.units != nil && sameDeltaEnvelope(tail.event, queued.event) &&
			len(tail.units)+len(queued.units) <= ObserverAgentTextChars &&
			subscription.pendingBytes+subscription.outputBytes+additional <= RPCEventQueueBytes {
			tail.units = append(tail.units, queued.units...)
			tail.bytes += additional
			subscription.pendingBytes += additional
			return true
		}
	}
	if len(subscription.pending)+len(subscription.channel) >= RPCEventQueue ||
		subscription.pendingBytes+subscription.outputBytes+queued.bytes > RPCEventQueueBytes {
		return false
	}
	subscription.pending = append(subscription.pending, queued)
	subscription.pendingBytes += queued.bytes
	return true
}

// Active delivery keeps at most one immutable event in the public channel.
// Its remaining capacity is reserved for an ordered, nonblocking close flush.
func (subscription *eventSubscription) dispatch() bool {
	if len(subscription.channel) == 0 && len(subscription.pending) > 0 {
		head := subscription.pending[0]
		subscription.channel <- head.materialize()
		subscription.outputBytes = head.bytes
		subscription.pendingBytes -= head.bytes
		subscription.pending[0] = queuedEvent{}
		subscription.pending = subscription.pending[1:]
	}
	return len(subscription.pending) > 0
}

func (subscription *eventSubscription) close() {
	for _, event := range subscription.pending {
		subscription.channel <- event.materialize()
	}
	subscription.pending = nil
	subscription.pendingBytes = 0
	close(subscription.channel)
}

func (value *RPC) wakeEvents() {
	select {
	case value.eventWake <- struct{}{}:
	default:
	}
}

func (value *RPC) dispatchEvents() {
	defer value.workers.Done()
	timer := time.NewTimer(eventDispatchDelay)
	defer timer.Stop()
	timer.Stop()
	var pending <-chan time.Time
	for {
		select {
		case <-value.ctx.Done():
			return
		case <-value.eventWake:
		case <-pending:
		}
		value.mu.Lock()
		waiting := false
		for _, subscription := range value.events {
			waiting = subscription.dispatch() || waiting
		}
		value.mu.Unlock()
		if waiting {
			timer.Reset(eventDispatchDelay)
			pending = timer.C
		} else {
			timer.Stop()
			pending = nil
		}
	}
}
