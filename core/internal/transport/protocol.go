// Package transport serves bounded, parent-controlled shadow queries over stdio.
// It never opens a port, logs payloads, or admits agent execution.
package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	RequestMaxBytes    = contracts.CoreRequestMaxBytes
	ResponseMaxBytes   = contracts.CoreResponseMaxBytes
	RequestIDMaxChars  = contracts.CoreRequestIdMaxChars
	Workers            = contracts.CoreWorkers
	QueueCapacity      = contracts.CoreQueueCapacity
	MaxSessionRequests = contracts.CoreMaxSessionRequests
	DefaultDeadline    = time.Duration(contracts.CoreDefaultDeadlineMs) * time.Millisecond
	MaxDeadline        = time.Duration(contracts.CoreMaxDeadlineMs) * time.Millisecond
	ShutdownTimeout    = time.Duration(contracts.CoreShutdownMs) * time.Millisecond
	maxJSONDepth       = 32
	MethodPing         = "ping"
	MethodSearch       = "search"
	MethodRetrieve     = "retrieve"
)

type Code string

const (
	InvalidRequest   Code = "invalid_request"
	InvalidParams    Code = "invalid_params"
	MethodNotAllowed Code = "method_not_allowed"
	DuplicateID      Code = "duplicate_id"
	Busy             Code = "busy"
	Cancelled        Code = "cancelled"
	DeadlineExceeded Code = "deadline_exceeded"
	FrameTooLarge    Code = "frame_too_large"
	ResponseTooLarge Code = "response_too_large"
	SessionLimit     Code = "session_limit"
	StaleSnapshot    Code = "stale_snapshot"
	InvalidSnapshot  Code = "invalid_snapshot"
	Unavailable      Code = "unavailable"
	InternalError    Code = "internal_error"
)

type codedError struct{ code Code }

func (e codedError) Error() string { return string(e.code) }

// NewError exposes only the fixed protocol vocabulary, never a raw cause.
func NewError(code Code) error {
	switch code {
	case InvalidRequest, InvalidParams, MethodNotAllowed, DuplicateID, Busy, Cancelled,
		DeadlineExceeded, FrameTooLarge, ResponseTooLarge, SessionLimit, StaleSnapshot,
		InvalidSnapshot, Unavailable:
		return codedError{code}
	default:
		return codedError{InternalError}
	}
}

func errorCode(err error) Code {
	if errors.Is(err, context.DeadlineExceeded) {
		return DeadlineExceeded
	}
	if errors.Is(err, context.Canceled) {
		return Cancelled
	}
	var code codedError
	if errors.As(err, &code) {
		return code.code
	}
	return InternalError
}

type Request struct {
	ID       string
	Method   string
	Params   json.RawMessage
	Deadline time.Duration
}

type Handler func(context.Context, Request) (json.RawMessage, error)

type decodedFrame struct {
	request Request
	cancel  string
	id      *string
}

func validID(id string) bool {
	if len(id) == 0 || len(id) > RequestIDMaxChars {
		return false
	}
	for _, value := range id {
		if !(value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || value == '_' || value == '-') {
			return false
		}
	}
	return true
}

// StrictObject preserves omission, rejects null/arrays and unknown fields, and
// detects duplicate keys, including escaped spellings of the same JSON name.
func StrictObject(raw json.RawMessage, allowed ...string) (map[string]json.RawMessage, error) {
	if !utf8.Valid(raw) || !validEscapes(raw) || len(raw) == 0 || len(raw) > RequestMaxBytes {
		return nil, NewError(InvalidParams)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := validateValue(decoder, 0); err != nil {
		return nil, NewError(InvalidParams)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, NewError(InvalidParams)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, NewError(InvalidParams)
	}
	for key := range object {
		found := false
		for _, expected := range allowed {
			if key == expected {
				found = true
				break
			}
		}
		if !found {
			return nil, NewError(InvalidParams)
		}
	}
	return object, nil
}

// encoding/json replaces lone UTF-16 surrogates. Reject them on input instead
// of changing an exact identity into another string containing U+FFFD.
func validEscapes(raw []byte) bool {
	quoted := false
	for index := 0; index < len(raw); index++ {
		if raw[index] == '"' {
			quoted = !quoted
			continue
		}
		if !quoted || raw[index] != '\\' {
			continue
		}
		index++
		if index >= len(raw) {
			return false
		}
		if raw[index] != 'u' {
			continue
		}
		if index+4 >= len(raw) {
			return false
		}
		value, err := strconv.ParseUint(string(raw[index+1:index+5]), 16, 16)
		if err != nil {
			return false
		}
		index += 4
		if value >= 0xdc00 && value <= 0xdfff {
			return false
		}
		if value >= 0xd800 && value <= 0xdbff {
			if index+6 >= len(raw) || raw[index+1] != '\\' || raw[index+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(raw[index+3:index+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			index += 6
		}
	}
	return !quoted
}

func validateValue(decoder *json.Decoder, depth int) error {
	if depth > maxJSONDepth {
		return NewError(InvalidParams)
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if delimiter, ok := token.(json.Delim); ok {
		switch delimiter {
		case '{':
			keys := make(map[string]bool)
			for decoder.More() {
				keyToken, err := decoder.Token()
				key, ok := keyToken.(string)
				if err != nil || !ok || keys[key] {
					return NewError(InvalidParams)
				}
				keys[key] = true
				if err := validateValue(decoder, depth+1); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim('}') {
				return NewError(InvalidParams)
			}
		case '[':
			for decoder.More() {
				if err := validateValue(decoder, depth+1); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim(']') {
				return NewError(InvalidParams)
			}
		default:
			return NewError(InvalidParams)
		}
	}
	return nil
}

func decode(raw []byte) (decodedFrame, error) {
	var frame decodedFrame
	object, err := StrictObject(raw, "id", "method", "params", "deadlineMs", "cancel")
	if err != nil {
		return frame, NewError(InvalidRequest)
	}
	if value, ok := object["id"]; ok {
		var id string
		if json.Unmarshal(value, &id) == nil && validID(id) {
			frame.id = &id
		}
	}
	if value, ok := object["cancel"]; ok {
		if len(object) != 1 || json.Unmarshal(value, &frame.cancel) != nil || !validID(frame.cancel) {
			return frame, NewError(InvalidRequest)
		}
		return frame, nil
	}
	if frame.id == nil {
		return frame, NewError(InvalidRequest)
	}
	frame.request.ID = *frame.id
	if json.Unmarshal(object["method"], &frame.request.Method) != nil {
		return frame, NewError(InvalidRequest)
	}
	switch frame.request.Method {
	case MethodPing, MethodSearch, MethodRetrieve:
	default:
		return frame, NewError(MethodNotAllowed)
	}
	frame.request.Deadline = DefaultDeadline
	if value, ok := object["deadlineMs"]; ok {
		var milliseconds int64
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &milliseconds) != nil || milliseconds <= 0 || milliseconds > contracts.CoreMaxDeadlineMs {
			return frame, NewError(InvalidParams)
		}
		frame.request.Deadline = time.Duration(milliseconds) * time.Millisecond
	}
	params, ok := object["params"]
	if !ok && frame.request.Method == MethodPing {
		params = json.RawMessage(`{}`)
	}
	var fields map[string]json.RawMessage
	if len(params) == 0 || json.Unmarshal(params, &fields) != nil || fields == nil {
		return frame, NewError(InvalidParams)
	}
	if frame.request.Method == MethodPing && len(fields) != 0 {
		return frame, NewError(InvalidParams)
	}
	frame.request.Params = params
	return frame, nil
}

func failure(id *string, code Code) []byte {
	frame, _ := json.Marshal(struct {
		ID    *string `json:"id"`
		Error struct {
			Code Code `json:"code"`
		} `json:"error"`
	}{ID: id, Error: struct {
		Code Code `json:"code"`
	}{Code: code}})
	return append(frame, '\n')
}

func success(id string, result json.RawMessage) []byte {
	if len(result) > ResponseMaxBytes {
		return failure(&id, ResponseTooLarge)
	}
	if len(result) == 0 || !utf8.Valid(result) || !json.Valid(result) {
		return failure(&id, InternalError)
	}
	frame, err := json.Marshal(struct {
		ID     string          `json:"id"`
		Result json.RawMessage `json:"result"`
	}{id, result})
	if err != nil {
		return failure(&id, InternalError)
	}
	if len(frame) > ResponseMaxBytes {
		return failure(&id, ResponseTooLarge)
	}
	return append(frame, '\n')
}
