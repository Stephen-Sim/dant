// Package runtime owns the authenticated Worker-side Codex App Server process
// boundary. It transports execution; Codex retains the model/tool reasoning loop.
package runtime

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	MaxRPCFrameBytes    = 64 * 1024 * 1024
	MaxPendingRequests  = 64
	RPCWriteQueue       = 32
	RPCEventQueue       = 64
	MaxEventSubscribers = 8
	MaxRPCIDBytes       = 1024
)

var (
	ErrDisconnected    = errors.New("executor_disconnected")
	ErrInvalidProtocol = errors.New("executor_protocol_invalid")
	ErrRequestTimeout  = errors.New("executor_request_timeout")
	ErrBackpressure    = errors.New("executor_backpressure")
	ErrRequestFailed   = errors.New("executor_request_failed")
)

// RPCID retains the provider's string/number distinction. Numeric spellings
// compare by JSON number value, just as the previous JavaScript Map did.
type RPCID struct {
	raw json.RawMessage
	key string
}

func ParseRPCID(raw json.RawMessage) (RPCID, error) {
	var value RPCID
	if len(raw) == 0 || len(raw) > MaxRPCIDBytes || !contracts.ValidUnicodeJSON(raw) {
		return value, ErrInvalidProtocol
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var decoded any
	if decoder.Decode(&decoded) != nil {
		return value, ErrInvalidProtocol
	}
	if _, err := decoder.Token(); err != io.EOF {
		return value, ErrInvalidProtocol
	}
	switch id := decoded.(type) {
	case string:
		value.key = "s:" + id
	case json.Number:
		number, err := strconv.ParseFloat(id.String(), 64)
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return value, ErrInvalidProtocol
		}
		if number == 0 {
			number = 0
		}
		value.key = "n:" + strconv.FormatFloat(number, 'g', -1, 64)
	default:
		return value, ErrInvalidProtocol
	}
	value.raw = bytes.Clone(raw)
	return value, nil
}

func NumericRPCID(value uint64) RPCID {
	raw := []byte(strconv.FormatUint(value, 10))
	result, _ := ParseRPCID(raw)
	return result
}

func (value RPCID) MarshalJSON() ([]byte, error) {
	if value.key == "" {
		return nil, ErrInvalidProtocol
	}
	return value.raw, nil
}

func (value *RPCID) UnmarshalJSON(raw []byte) error {
	decoded, err := ParseRPCID(raw)
	if err != nil {
		return err
	}
	*value = decoded
	return nil
}

func (value RPCID) Key() string {
	return value.key
}

type Event struct {
	// Captured by the Worker Engine before asynchronous tool dispatch. This is
	// local ownership metadata, never supplied by Codex or serialized on the wire.
	MediaCallID           contracts.Optional[string] `json:"-"`
	Method                string                     `json:"method"`
	Params                contracts.RawObject        `json:"params"`
	ID                    contracts.Optional[RPCID]  `json:"id,omitzero"`
	Projection            ObserverProjection         `json:"-"`
	TaskExecutionObserved bool                       `json:"-"`
}

func (value Event) IsRequest() bool {
	return value.ID.Present && !value.ID.Null && value.ID.Value.key != ""
}

// OperationError separates transport uncertainty from an explicit provider
// rejection. Error never prints arbitrary provider text or request content.
type OperationError struct {
	Cause          error
	UnknownOutcome bool
	Code           json.RawMessage
	Message        string
	Data           json.RawMessage
}

func (value *OperationError) Error() string {
	if value.Cause != nil {
		return value.Cause.Error()
	}
	return ErrRequestFailed.Error()
}

func (value *OperationError) Unwrap() error {
	return value.Cause
}

func (value *OperationError) UnconfirmedOutcome() bool { return value.UnknownOutcome }

func decodeEvent(object contracts.RawObject) (Event, error) {
	var event Event
	if !contracts.ValidUnicodeJSON(object["method"]) || json.Unmarshal(object["method"], &event.Method) != nil || event.Method == "" {
		return event, ErrInvalidProtocol
	}
	if raw, exists := object["params"]; exists {
		params, err := contracts.DecodeObject(raw, MaxRPCFrameBytes)
		if err != nil {
			return event, ErrInvalidProtocol
		}
		event.Params = params
	} else {
		event.Params = make(contracts.RawObject)
	}
	if raw, exists := object["id"]; exists {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			event.ID = contracts.Null[RPCID]()
		} else {
			id, err := ParseRPCID(raw)
			if err != nil {
				return event, err
			}
			event.ID = contracts.Some(id)
		}
	}
	return event, nil
}
