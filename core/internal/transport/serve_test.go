package transport

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type testResponse struct {
	ID     *string         `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code Code `json:"code"`
	} `json:"error"`
}

type session struct {
	input     *io.PipeWriter
	responses <-chan []byte
	done      <-chan error
	cancel    context.CancelFunc
}

func startSession(t *testing.T, handler Handler) *session {
	t.Helper()
	input, send := io.Pipe()
	output, sink := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	responses := make(chan []byte, 64)
	go func() { done <- Serve(ctx, input, sink, handler); sink.Close() }()
	go func() {
		defer close(responses)
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 1024), ResponseMaxBytes+2)
		for scanner.Scan() {
			responses <- bytes.Clone(scanner.Bytes())
		}
	}()
	value := &session{send, responses, done, cancel}
	t.Cleanup(func() { cancel(); send.Close(); output.Close() })
	return value
}

func (value *session) send(t *testing.T, frame string) {
	t.Helper()
	if _, err := io.WriteString(value.input, frame+"\n"); err != nil {
		t.Fatalf("fixture send: %v", err)
	}
}

func (value *session) receive(t *testing.T) testResponse {
	t.Helper()
	select {
	case raw, open := <-value.responses:
		if !open {
			t.Fatal("response stream ended early")
		}
		if len(raw) > ResponseMaxBytes {
			t.Fatal("response frame exceeded its byte limit")
		}
		var response testResponse
		if err := json.Unmarshal(raw, &response); err != nil {
			t.Fatalf("invalid response framing: %v", err)
		}
		if (response.Error == nil) == (response.Result == nil) {
			t.Fatal("a terminal frame must contain exactly result or error")
		}
		return response
	case <-time.After(3 * time.Second):
		t.Fatal("response not received")
	}
	return testResponse{}
}

func (value *session) quiet(t *testing.T) {
	t.Helper()
	select {
	case raw := <-value.responses:
		t.Fatalf("unexpected additional terminal frame (%d bytes)", len(raw))
	case <-time.After(20 * time.Millisecond):
	}
}

func expectCode(t *testing.T, response testResponse, code Code) {
	t.Helper()
	if response.Error == nil || response.Error.Code != code {
		t.Fatalf("expected code %s, got %#v", code, response.Error)
	}
}

func pingHandler(_ context.Context, _ Request) (json.RawMessage, error) {
	return json.RawMessage(`{"ok":true}`), nil
}

func TestStrictFramesDoNotCoerceIdentityNullOrUnexpectedFields(t *testing.T) {
	for _, test := range []struct {
		name, frame string
		code        Code
	}{
		{"unknown field", `{"id":"one","method":"ping","extra":"private"}`, InvalidRequest},
		{"duplicate escaped key", `{"id":"one","\u0069d":"two","method":"ping"}`, InvalidRequest},
		{"duplicate nested key", `{"id":"one","method":"search","params":{"query":{"terms":[],"terms":[]}}}`, InvalidRequest},
		{"non-ascii identity", `{"id":"中文","method":"ping"}`, InvalidRequest},
		{"overlong identity", `{"id":"` + strings.Repeat("a", RequestIDMaxChars+1) + `","method":"ping"}`, InvalidRequest},
		{"invalid surrogate", `{"id":"one","method":"search","params":{"conversationId":"\ud800","query":{"terms":[]}}}`, InvalidRequest},
		{"null params", `{"id":"one","method":"ping","params":null}`, InvalidParams},
		{"non-object params", `{"id":"one","method":"search","params":[]}`, InvalidParams},
		{"missing params", `{"id":"one","method":"retrieve"}`, InvalidParams},
		{"ping fields", `{"id":"one","method":"ping","params":{"extra":true}}`, InvalidParams},
		{"method allowlist", `{"id":"one","method":"run_task","params":{}}`, MethodNotAllowed},
		{"null deadline", `{"id":"one","method":"ping","deadlineMs":null}`, InvalidParams},
		{"zero deadline", `{"id":"one","method":"ping","deadlineMs":0}`, InvalidParams},
		{"over deadline", `{"id":"one","method":"ping","deadlineMs":10001}`, InvalidParams},
		{"second document", `{"id":"one","method":"ping"} {}`, InvalidRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			session := startSession(t, func(context.Context, Request) (json.RawMessage, error) { calls.Add(1); return nil, nil })
			session.send(t, test.frame)
			expectCode(t, session.receive(t), test.code)
			if calls.Load() != 0 {
				t.Fatal("invalid frame reached the handler")
			}
		})
	}
}

func TestExactByteLimitAndMaximumASCIIIdentity(t *testing.T) {
	session := startSession(t, pingHandler)
	frame := `{"id":"` + strings.Repeat("A", RequestIDMaxChars) + `","method":"ping"}`
	session.send(t, frame+strings.Repeat(" ", RequestMaxBytes-len(frame)))
	response := session.receive(t)
	if response.Error != nil || response.ID == nil || len(*response.ID) != RequestIDMaxChars {
		t.Fatal("valid boundary request was rejected")
	}
	oversize := startSession(t, pingHandler)
	oversize.send(t, frame+strings.Repeat(" ", RequestMaxBytes-len(frame)+1))
	expectCode(t, oversize.receive(t), FrameTooLarge)
}

func TestCancellationTargetsOnlyPendingIdentityAndHasOneTerminal(t *testing.T) {
	started := make(chan struct{}, 1)
	session := startSession(t, func(ctx context.Context, request Request) (json.RawMessage, error) {
		if request.Method == MethodPing {
			return pingHandler(ctx, request)
		}
		started <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	})
	session.send(t, `{"id":"active","method":"search","params":{}}`)
	<-started
	session.send(t, `{"cancel":"another"}`)
	session.quiet(t)
	session.send(t, `{"cancel":"active"}`)
	response := session.receive(t)
	expectCode(t, response, Cancelled)
	if response.ID == nil || *response.ID != "active" {
		t.Fatal("cancellation lost request identity")
	}
	session.send(t, `{"cancel":"active"}`)
	session.quiet(t)
	session.send(t, `{"id":"later","method":"ping"}`)
	if response := session.receive(t); response.Error != nil {
		t.Fatal("cancellation stopped an unrelated request")
	}
}

func TestDuplicateIdentityCannotBeReusedAfterItsTerminal(t *testing.T) {
	session := startSession(t, pingHandler)
	session.send(t, `{"id":"once","method":"ping"}`)
	if response := session.receive(t); response.Error != nil {
		t.Fatal("first request failed")
	}
	session.send(t, `{"id":"once","method":"ping"}`)
	response := session.receive(t)
	expectCode(t, response, DuplicateID)
	if response.ID != nil {
		t.Fatal("duplicate identity must not consume another request's result")
	}
	select {
	case err := <-session.done:
		if err == nil {
			t.Fatal("duplicate identity did not close the session")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("duplicate session did not end")
	}
}

func TestDuplicateIdentityCannotEscapeTheTombstoneThroughInvalidParamsOrMethods(t *testing.T) {
	for _, test := range []struct {
		name, first, second string
		pending             bool
	}{
		{"pending then invalid params", `{"id":"once","method":"search","params":{}}`, `{"id":"once","method":"ping","params":null}`, true},
		{"completed then invalid method", `{"id":"once","method":"ping"}`, `{"id":"once","method":"task_execute","params":{}}`, false},
		{"rejected then valid", `{"id":"once","method":"ping","params":null}`, `{"id":"once","method":"ping"}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			// This test owns request ordering. Host scheduling must not turn
			// its still-pending request into a real-time deadline or I/O stall.
			synctest.Test(t, func(t *testing.T) {
				started := make(chan struct{}, 1)
				session := startSession(t, func(ctx context.Context, request Request) (json.RawMessage, error) {
					if test.pending {
						started <- struct{}{}
						<-ctx.Done()
						return nil, ctx.Err()
					}
					return pingHandler(ctx, request)
				})
				session.send(t, test.first)
				if test.pending {
					select {
					case <-started:
					case <-time.After(time.Second):
						t.Fatal("first request did not begin")
					}
				} else {
					session.receive(t)
				}
				session.send(t, test.second)
				response := session.receive(t)
				expectCode(t, response, DuplicateID)
				if response.ID != nil {
					t.Fatal("a duplicate request produced a correlated second terminal")
				}
				select {
				case err := <-session.done:
					if err == nil {
						t.Fatal("duplicate session remained open")
					}
				case <-time.After(2 * ShutdownTimeout):
					t.Fatal("duplicate session did not terminate")
				}
				select {
				case frame, open := <-session.responses:
					if open {
						t.Fatalf("another terminal escaped (%d bytes)", len(frame))
					}
				case <-time.After(time.Second):
					t.Fatal("terminal stream did not close")
				}
			})
		})
	}
}

func TestDeadlinesBoundedQueueAndNoncooperativeHandlersKeepTheirPhysicalSlots(t *testing.T) {
	started := make(chan struct{}, Workers)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	var active, maximum atomic.Int32
	session := startSession(t, func(context.Context, Request) (json.RawMessage, error) {
		count := active.Add(1)
		for previous := maximum.Load(); count > previous; previous = maximum.Load() {
			if maximum.CompareAndSwap(previous, count) {
				break
			}
		}
		started <- struct{}{}
		<-release
		active.Add(-1)
		return json.RawMessage(`[]`), nil
	})
	for index := 0; index < Workers; index++ {
		session.send(t, fmt.Sprintf(`{"id":"active-%d","method":"search","params":{}}`, index))
	}
	for index := 0; index < Workers; index++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("worker did not start")
		}
	}
	for index := 0; index < QueueCapacity; index++ {
		session.send(t, fmt.Sprintf(`{"id":"queued-%d","method":"search","params":{},"deadlineMs":10}`, index))
	}
	session.send(t, `{"id":"overflow","method":"search","params":{}}`)
	counts := make(map[Code]int)
	for index := 0; index < QueueCapacity+1; index++ {
		response := session.receive(t)
		if response.Error == nil {
			t.Fatal("saturated requests unexpectedly succeeded")
		}
		counts[response.Error.Code]++
	}
	if counts[Busy] != 1 || counts[DeadlineExceeded] != QueueCapacity {
		t.Fatalf("unexpected saturation outcomes: %v", counts)
	}
	for index := 0; index < Workers; index++ {
		session.send(t, fmt.Sprintf(`{"cancel":"active-%d"}`, index))
	}
	for index := 0; index < Workers; index++ {
		expectCode(t, session.receive(t), Cancelled)
	}
	if maximum.Load() != Workers || active.Load() != Workers {
		t.Fatal("cancellation replaced handlers that were still executing")
	}
	start := time.Now()
	session.cancel()
	select {
	case <-session.done:
	case <-time.After(2 * ShutdownTimeout):
		t.Fatal("shutdown waited for noncooperative handlers")
	}
	if time.Since(start) > 2*ShutdownTimeout {
		t.Fatal("shutdown was not bounded")
	}
}

func TestDuplicateSessionWithBlockedOutputStopsAtTheUnchangedShutdownBoundary(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		input, send := io.Pipe()
		writer := &closingWriter{start: make(chan struct{}), release: make(chan struct{})}
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(func() { cancel(); send.Close() })
		started, stopped := make(chan struct{}), make(chan struct{})
		done := make(chan error, 1)
		go func() {
			done <- Serve(ctx, input, writer, func(ctx context.Context, _ Request) (json.RawMessage, error) {
				close(started)
				<-ctx.Done()
				close(stopped)
				return nil, ctx.Err()
			})
		}()
		if _, err := io.WriteString(send, `{"id":"once","method":"search","params":{}}`+"\n"); err != nil {
			t.Fatal(err)
		}
		<-started
		if _, err := io.WriteString(send, `{"id":"once","method":"ping","params":null}`+"\n"); err != nil {
			t.Fatal(err)
		}
		<-writer.start
		synctest.Wait()
		select {
		case <-stopped:
		default:
			t.Fatal("the session error did not cancel its pending request")
		}
		start := time.Now()
		time.Sleep(ShutdownTimeout - time.Nanosecond)
		synctest.Wait()
		select {
		case <-done:
			t.Fatal("blocked output ended before its configured drain boundary")
		default:
		}
		time.Sleep(time.Nanosecond)
		if err := <-done; err == nil || err.Error() != string(DuplicateID) {
			t.Fatal("the session protocol failure was not retained")
		}
		if time.Since(start) != ShutdownTimeout {
			t.Fatal("blocked output did not use the unchanged shutdown limit")
		}
		synctest.Wait()
		select {
		case <-writer.release:
		default:
			t.Fatal("the blocked output was not closed")
		}
		if writer.calls.Load() != 1 {
			t.Fatal("an undelivered terminal frame was automatically resent")
		}
	})
}

func TestDeadlineDefaultsAndLimitsComeFromTheRequestContext(t *testing.T) {
	session := startSession(t, func(ctx context.Context, request Request) (json.RawMessage, error) {
		deadline, ok := ctx.Deadline()
		if !ok {
			return nil, NewError(InternalError)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 || remaining > request.Deadline {
			return nil, NewError(InternalError)
		}
		return json.Marshal(struct {
			Deadline int64 `json:"deadline"`
		}{request.Deadline.Milliseconds()})
	})
	for _, test := range []struct {
		frame    string
		expected int64
	}{
		{`{"id":"default","method":"ping"}`, DefaultDeadline.Milliseconds()},
		{`{"id":"maximum","method":"ping","deadlineMs":10000}`, MaxDeadline.Milliseconds()},
	} {
		session.send(t, test.frame)
		response := session.receive(t)
		var result struct {
			Deadline int64 `json:"deadline"`
		}
		if response.Error != nil || json.Unmarshal(response.Result, &result) != nil || result.Deadline != test.expected {
			t.Fatal("deadline contract changed")
		}
	}
}

func TestUncorrelatedProtocolErrorEndsTheSessionAndCancelsItsPendingWork(t *testing.T) {
	started, stopped := make(chan struct{}, Workers), make(chan struct{}, Workers)
	session := startSession(t, func(ctx context.Context, _ Request) (json.RawMessage, error) {
		started <- struct{}{}
		<-ctx.Done()
		stopped <- struct{}{}
		return json.RawMessage(`{"late":true}`), nil
	})
	for index := 0; index < 2; index++ {
		session.send(t, fmt.Sprintf(`{"id":"pending-%d","method":"search","params":{}}`, index))
	}
	for index := 0; index < 2; index++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("fixture work did not start")
		}
	}
	session.send(t, `{"id":"中文","method":"ping"}`)
	response := session.receive(t)
	expectCode(t, response, InvalidRequest)
	if response.ID != nil {
		t.Fatal("invalid request identity was silently replaced")
	}
	for index := 0; index < 2; index++ {
		select {
		case <-stopped:
		case <-time.After(2 * ShutdownTimeout):
			t.Fatal("a session error did not cancel all work")
		}
	}
	select {
	case err := <-session.done:
		if err == nil || err.Error() != string(InvalidRequest) {
			t.Fatal("session protocol failure was not retained")
		}
	case <-time.After(2 * ShutdownTimeout):
		t.Fatal("session protocol error did not close Serve")
	}
	select {
	case raw, open := <-session.responses:
		if open {
			t.Fatalf("a pending result escaped the session failure (%d bytes)", len(raw))
		}
	case <-time.After(time.Second):
		t.Fatal("session response stream remained open")
	}
}

func TestEOFAndUnterminatedFramesCancelWorkWithoutInventingAResult(t *testing.T) {
	for _, unterminated := range []bool{false, true} {
		t.Run(fmt.Sprintf("partial-%t", unterminated), func(t *testing.T) {
			started, stopped := make(chan struct{}), make(chan struct{})
			session := startSession(t, func(ctx context.Context, _ Request) (json.RawMessage, error) {
				close(started)
				<-ctx.Done()
				close(stopped)
				return nil, ctx.Err()
			})
			session.send(t, `{"id":"pending","method":"search","params":{}}`)
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("fixture work did not begin")
			}
			if unterminated {
				if _, err := io.WriteString(session.input, `{"id":"partial"`); err != nil {
					t.Fatal(err)
				}
			}
			session.input.Close()
			if unterminated {
				response := session.receive(t)
				expectCode(t, response, InvalidRequest)
				if response.ID != nil {
					t.Fatal("an incomplete frame invented a correlated identity")
				}
			}
			select {
			case <-stopped:
			case <-time.After(2 * ShutdownTimeout):
				t.Fatal("EOF did not cancel active work")
			}
			select {
			case <-session.done:
			case <-time.After(2 * ShutdownTimeout):
				t.Fatal("EOF did not end Serve")
			}
			select {
			case raw, open := <-session.responses:
				if open {
					t.Fatalf("EOF invented a request result (%d bytes)", len(raw))
				}
			case <-time.After(time.Second):
				t.Fatal("EOF did not close responses")
			}
		})
	}
}

func TestResponseLimitIncludesEnvelopeAndEscapingOverhead(t *testing.T) {
	id := "one"
	baseline := success(id, json.RawMessage(`""`))
	// Remove the newline from the wire size. The largest valid result must
	// leave space for both the stable identity and the response envelope.
	remaining := ResponseMaxBytes - (len(baseline) - 1)
	frame := success(id, json.RawMessage(`"`+strings.Repeat("x", remaining)+`"`))
	if len(frame)-1 != ResponseMaxBytes {
		t.Fatal("the exact response boundary was not accepted")
	}
	frame = success(id, json.RawMessage(`"`+strings.Repeat("x", remaining+1)+`"`))
	var response testResponse
	if json.Unmarshal(frame, &response) != nil {
		t.Fatal("oversize result broke response framing")
	}
	expectCode(t, response, ResponseTooLarge)
	frame = success(id, json.RawMessage(`"`+strings.Repeat("<", ResponseMaxBytes/6)+`"`))
	if json.Unmarshal(frame, &response) != nil {
		t.Fatal("escaped oversize result broke framing")
	}
	expectCode(t, response, ResponseTooLarge)
}

func TestHandlerFailuresPanicsAndOversizeOutputNeverExposeRawCauses(t *testing.T) {
	for _, test := range []struct {
		name    string
		handler Handler
		code    Code
	}{
		{"raw error", func(context.Context, Request) (json.RawMessage, error) {
			return nil, errors.New("private query and credentials")
		}, InternalError},
		{"panic", func(context.Context, Request) (json.RawMessage, error) { panic("private panic content") }, InternalError},
		{"known error", func(context.Context, Request) (json.RawMessage, error) { return nil, NewError(StaleSnapshot) }, StaleSnapshot},
		{"oversize result", func(context.Context, Request) (json.RawMessage, error) {
			return json.RawMessage(`"` + strings.Repeat("x", ResponseMaxBytes) + `"`), nil
		}, ResponseTooLarge},
		{"invalid result", func(context.Context, Request) (json.RawMessage, error) {
			return json.RawMessage(`not JSON private content`), nil
		}, InternalError},
	} {
		t.Run(test.name, func(t *testing.T) {
			session := startSession(t, test.handler)
			session.send(t, `{"id":"one","method":"ping"}`)
			response := session.receive(t)
			expectCode(t, response, test.code)
			if len(response.Result) != 0 {
				t.Fatal("error contained a result")
			}
		})
	}
}

func TestSessionTombstonesHaveABoundedFailClosedLifetime(t *testing.T) {
	session := startSession(t, pingHandler)
	for index := 0; index < MaxSessionRequests; index++ {
		session.send(t, fmt.Sprintf(`{"id":"request-%d","method":"ping"}`, index))
		if response := session.receive(t); response.Error != nil {
			t.Fatal("session stopped before its documented limit")
		}
	}
	session.send(t, `{"id":"over-session-limit","method":"ping"}`)
	expectCode(t, session.receive(t), SessionLimit)
}

type blockingReader struct{ release <-chan struct{} }

func (reader blockingReader) Read([]byte) (int, error) { <-reader.release; return 0, io.EOF }

func TestCancelledServeReturnsWithoutABlockedReaderHoldingItsWriter(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	release := make(chan struct{})
	defer close(release)
	var output bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, blockingReader{release}, &output, pingHandler) }()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * ShutdownTimeout):
		t.Fatal("blocked reader retained Serve")
	}
	if output.Len() != 0 {
		t.Fatal("an abandoned reader produced output")
	}
}

type closingWriter struct {
	start   chan struct{}
	release chan struct{}
	once    sync.Once
	calls   atomic.Int32
}

func (writer *closingWriter) Write([]byte) (int, error) {
	writer.calls.Add(1)
	writer.once.Do(func() { close(writer.start) })
	<-writer.release
	return 0, io.ErrClosedPipe
}
func (writer *closingWriter) Close() error { close(writer.release); return nil }

func TestBlockedOutputIsClosedAfterABoundedShutdown(t *testing.T) {
	input, send := io.Pipe()
	writer := &closingWriter{start: make(chan struct{}), release: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer send.Close()
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, input, writer, pingHandler) }()
	if _, err := io.WriteString(send, `{"id":"one","method":"ping"}`+"\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-writer.start:
	case <-time.After(time.Second):
		t.Fatal("writer was not reached")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("blocked output was not reported")
		}
	case <-time.After(2 * ShutdownTimeout):
		t.Fatal("output shutdown was unbounded")
	}
}
