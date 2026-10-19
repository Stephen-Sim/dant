package runtime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const RequestTimeout = 60 * time.Second

type rpcResult struct {
	object contracts.RawObject
	err    error
}
type pendingRequest struct {
	result chan rpcResult
	sent   *atomic.Bool
}
type writeFrame struct {
	ctx    context.Context
	guard  func() error
	data   []byte
	result chan error
	sent   *atomic.Bool
}
type RPC struct {
	ctx      context.Context
	cancel   context.CancelFunc
	input    io.WriteCloser
	output   io.ReadCloser
	stop     func()
	mu       sync.Mutex
	closed   bool
	next     uint64
	pending  map[string]*pendingRequest
	events   map[chan Event]func(Event) bool
	writes   chan writeFrame
	done     chan struct{}
	workers  sync.WaitGroup
	stopOnce sync.Once
}

func NewRPC(
	ctx context.Context,
	input io.WriteCloser,
	output io.ReadCloser,
	stop func()) (*RPC, error) {
	if input == nil || output == nil {
		return nil, ErrDisconnected
	}
	lifetime, cancel := context.WithCancel(ctx)
	value := &RPC{
		ctx:    lifetime,
		cancel: cancel,
		input:  input,
		output: output,
		stop:   stop,

		pending: make(map[string]*pendingRequest),
		events:  make(map[chan Event]func(Event) bool),
		writes:  make(chan writeFrame, RPCWriteQueue),
		done:    make(chan struct{}),
	}
	value.workers.Add(2)
	go value.read()
	go value.write()
	go func() {
		value.workers.Wait()
		close(value.done)
	}()
	go func() {
		<-lifetime.Done()
		value.fail(ErrDisconnected)
	}()
	return value, nil
}

func (value *RPC) Done() <-chan struct{} {
	return value.done
}

func (value *RPC) Closed() bool {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.closed
}

func (value *RPC) fail(cause error) {
	value.mu.Lock()
	if value.closed {
		value.mu.Unlock()
		return
	}
	value.closed = true
	for key, pending := range value.pending {
		pending.result <- rpcResult{err: &OperationError{Cause: cause, UnknownOutcome: pending.sent.Load()}}
		delete(value.pending, key)
	}
	for channel := range value.events {
		close(channel)
		delete(value.events, channel)
	}
	value.mu.Unlock()
	value.cancel()
	value.stopOnce.Do(func() {
		go func() {
			_ = value.input.Close()
			_ = value.output.Close()
			if value.stop != nil {
				value.stop()
			}
		}()
	})
}

func (value *RPC) Close() {
	value.fail(ErrDisconnected)
}

func (value *RPC) SubscribeEvents() (
	<-chan Event,
	func(),
	error) {
	return value.subscribeEvents(nil)
}

// Filters are fixed local method predicates, never callbacks into consumers.
// An account monitor must not buffer unrelated task/image observer events while
// an account/read response is pending.
func (value *RPC) subscribeEvents(filter func(Event) bool) (<-chan Event, func(), error) {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed {
		return nil, nil, ErrDisconnected
	}
	if len(value.events) >= MaxEventSubscribers {
		return nil, nil, ErrBackpressure
	}
	channel := make(chan Event, RPCEventQueue)
	value.events[channel] = filter
	var once sync.Once
	return channel, func() {
		once.Do(func() {
			value.mu.Lock()
			defer value.mu.Unlock()
			if _, exists := value.events[channel]; exists {
				delete(value.events, channel)
				close(channel)
			}
		})
	}, nil
}

func (value *RPC) emit(event Event) bool {
	value.mu.Lock()
	if value.closed {
		value.mu.Unlock()
		return false
	}
	overflow := false
	for channel, filter := range value.events {
		if filter != nil && !filter(event) {
			continue
		}
		select {
		case channel <- event:
		default:
			overflow = true
		}
	}
	value.mu.Unlock()
	if overflow {
		value.fail(ErrBackpressure)
		return false
	}
	return true
}

func (value *RPC) write() {
	defer value.workers.Done()
	for {
		select {
		case <-value.ctx.Done():
			return
		case frame := <-value.writes:
			if err := frame.ctx.Err(); err != nil {
				frame.result <- err
				continue
			}
			if value.ctx.Err() != nil {
				return
			}
			if frame.guard != nil {
				if err := frame.guard(); err != nil {
					frame.result <- err
					continue
				}
			}
			frame.sent.Store(true)
			count, err := value.input.Write(frame.data)
			if err != nil || count != len(frame.data) {
				frame.result <- ErrDisconnected
				value.fail(ErrDisconnected)
				return
			}
			frame.result <- nil
		}
	}
}

func (value *RPC) read() {
	defer value.workers.Done()
	scanner := bufio.NewScanner(value.output)
	scanner.Buffer(make([]byte, 4096), MaxRPCFrameBytes+1)
	for scanner.Scan() {
		raw := scanner.Bytes()
		if len(raw) > MaxRPCFrameBytes {
			value.fail(ErrInvalidProtocol)
			return
		}
		object, err := contracts.DecodeObject(raw, MaxRPCFrameBytes)
		if err != nil {
			value.fail(ErrInvalidProtocol)
			return
		}
		if _, exists := object["method"]; exists {
			event, err := decodeEvent(object)
			if err != nil {
				value.fail(err)
				return
			}
			if !value.emit(PrepareObserverEvent(event)) {
				return
			}
			continue
		}
		id, err := ParseRPCID(object["id"])
		if err != nil {
			continue
		}
		value.mu.Lock()
		pending := value.pending[id.key]
		if pending != nil {
			delete(value.pending, id.key)
		}
		value.mu.Unlock()
		if pending == nil {
			continue
		}
		if errorRaw, exists := object["error"]; exists && !bytes.Equal(bytes.TrimSpace(errorRaw), []byte("null")) {
			provider, err := contracts.DecodeObject(errorRaw, MaxRPCFrameBytes)
			if err != nil || !validRPCError(provider) {
				pending.result <- rpcResult{err: &OperationError{Cause: ErrInvalidProtocol, UnknownOutcome: true}}
				value.fail(ErrInvalidProtocol)
				return
			}
			var message string
			_ = json.Unmarshal(provider["message"], &message)
			pending.result <- rpcResult{err: &OperationError{Cause: ErrRequestFailed, Code: provider["code"], Message: message, Data: provider["data"]}}
			continue
		}
		result, err := ReadRPCResult(object["result"])
		if err != nil {
			pending.result <- rpcResult{err: &OperationError{Cause: ErrInvalidProtocol, UnknownOutcome: true}}
			continue
		}
		pending.result <- rpcResult{object: result}
	}
	value.fail(ErrDisconnected)
}

func validMethod(method string) bool {
	return method != "" && len(method) <= 256 && !strings.ContainsAny(method, "\x00\r\n")
}

func (value *RPC) queue(
	ctx context.Context,
	object contracts.RawObject,
	sent *atomic.Bool,
	guard func() error) (<-chan error, error) {
	raw, err := json.Marshal(object)
	if err != nil || len(raw) > MaxRPCFrameBytes {
		return nil, ErrInvalidProtocol
	}
	raw = append(raw, '\n')
	ack := make(chan error, 1)
	frame := writeFrame{ctx: ctx, guard: guard, data: raw, result: ack, sent: sent}
	select {
	case <-value.ctx.Done():
		return nil, ErrDisconnected
	case <-ctx.Done():
		return nil, ctx.Err()
	case value.writes <- frame:
		return ack, nil
	default:
		return nil, ErrBackpressure
	}
}

func (value *RPC) Request(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
	return value.RequestGuarded(ctx, method, params, nil)
}

// RequestGuarded checks captured ownership immediately before the one writer
// sends a queued frame. A rejected guard is a proven unsent operation.
func (value *RPC) RequestGuarded(
	ctx context.Context,
	method string,
	params contracts.RawObject,
	guard func() error) (contracts.RawObject, error) {
	if !validMethod(method) {
		return nil, ErrInvalidProtocol
	}
	if params == nil {
		params = make(contracts.RawObject)
	}
	requestContext, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	sent := new(atomic.Bool)
	pending := &pendingRequest{result: make(chan rpcResult, 1), sent: sent}
	value.mu.Lock()
	if value.closed {
		value.mu.Unlock()
		return nil, ErrDisconnected
	}
	if len(value.pending) >= MaxPendingRequests || value.next >= 9_007_199_254_740_991 {
		value.mu.Unlock()
		return nil, ErrBackpressure
	}
	value.next++
	id := NumericRPCID(value.next)
	value.pending[id.key] = pending
	value.mu.Unlock()
	defer func() {
		value.mu.Lock()
		if value.pending[id.key] == pending {
			delete(value.pending, id.key)
		}
		value.mu.Unlock()
	}()
	idRaw, _ := json.Marshal(id)
	methodRaw, _ := json.Marshal(method)
	paramsRaw, err := json.Marshal(params)
	if err != nil {
		return nil, ErrInvalidProtocol
	}
	ack, err := value.queue(requestContext, contracts.RawObject{"id": idRaw, "method": methodRaw, "params": paramsRaw}, sent, guard)
	if err != nil {
		return nil, &OperationError{Cause: err, UnknownOutcome: sent.Load()}
	}
	for {
		select {
		case result := <-pending.result:
			return result.object, result.err
		case err := <-ack:
			if err != nil {
				return nil, &OperationError{Cause: err, UnknownOutcome: sent.Load()}
			}
			ack = nil
		case <-requestContext.Done():
			if ctx.Err() == nil && errors.Is(requestContext.Err(), context.DeadlineExceeded) {
				value.fail(ErrRequestTimeout)
				return nil, &OperationError{Cause: ErrRequestTimeout, UnknownOutcome: sent.Load()}
			}
			return nil, &OperationError{Cause: requestContext.Err(), UnknownOutcome: sent.Load()}
		case <-value.ctx.Done():
			return nil, &OperationError{Cause: ErrDisconnected, UnknownOutcome: sent.Load()}
		}
	}
}

func (value *RPC) Reply(ctx context.Context, id RPCID, result json.RawMessage) error {
	if id.key == "" || !json.Valid(result) {
		return ErrInvalidProtocol
	}
	idRaw, _ := json.Marshal(id)
	ack, err := value.queue(ctx, contracts.RawObject{"id": idRaw, "result": result}, new(atomic.Bool), nil)
	if err != nil {
		return err
	}
	select {
	case err := <-ack:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-value.ctx.Done():
		return ErrDisconnected
	}
}

func (value *RPC) ReplyError(ctx context.Context, id RPCID, code int, message string) error {
	if id.key == "" || contracts.UTF16Length(message) > 1024 {
		return ErrInvalidProtocol
	}
	idRaw, _ := json.Marshal(id)
	errorRaw, _ := json.Marshal(struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}{code, message})
	ack, err := value.queue(ctx, contracts.RawObject{"id": idRaw, "error": errorRaw}, new(atomic.Bool), nil)
	if err != nil {
		return err
	}
	select {
	case err := <-ack:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-value.ctx.Done():
		return ErrDisconnected
	}
}

func (value *RPC) Notify(ctx context.Context, method string, params contracts.RawObject) error {
	if !validMethod(method) {
		return ErrInvalidProtocol
	}
	if params == nil {
		params = make(contracts.RawObject)
	}
	methodRaw, _ := json.Marshal(method)
	paramsRaw, err := json.Marshal(params)
	if err != nil {
		return ErrInvalidProtocol
	}
	ack, err := value.queue(ctx, contracts.RawObject{"method": methodRaw, "params": paramsRaw}, new(atomic.Bool), nil)
	if err != nil {
		return err
	}
	select {
	case err := <-ack:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-value.ctx.Done():
		return ErrDisconnected
	}
}
