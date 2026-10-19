package work

import (
	"encoding/json"
	"sync"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const MaxSignalSubscribers = 8
const SignalQueue = 64

type Signal struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func (value *Engine) SubscribeSignals() (<-chan Signal, func(), error) {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed {
		return nil, nil, ErrClosed
	}
	if value.signals == nil {
		value.signals = make(map[chan Signal]struct{})
	}
	if len(value.signals) >= MaxSignalSubscribers {
		return nil, nil, ErrBusy
	}
	channel := make(chan Signal, SignalQueue)
	value.signals[channel] = struct{}{}
	var once sync.Once
	return channel, func() {
		once.Do(func() {
			value.mu.Lock()
			defer value.mu.Unlock()
			if _, exists := value.signals[channel]; exists {
				delete(value.signals, channel)
				close(channel)
			}
		})
	}, nil
}

func (value *Engine) signalLocked(kind string, data json.RawMessage) {
	for channel := range value.signals {
		select {
		case channel <- Signal{Type: kind, Data: append(json.RawMessage(nil), data...)}:
		default:
			close(channel)
			delete(value.signals, channel)
		}
	}
}

func (value *Engine) notice(message string) {
	message = value.redact(message)
	if contracts.UTF16Length(message) > 1000 {
		message = "The operation could not be confirmed."
	}
	value.mu.Lock()
	value.signalLocked("notice", raw(contracts.RawObject{"message": raw(message)}))
	value.mu.Unlock()
}
