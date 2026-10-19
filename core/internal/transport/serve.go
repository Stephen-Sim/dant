package transport

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync/atomic"
	"time"
)

const readerBufferBytes = 16 * 1024

type readEvent struct {
	frame []byte
	err   error
}
type job struct {
	request Request
	ctx     context.Context
	cancel  context.CancelFunc
	stop    func() bool
}
type completion struct {
	job    *job
	result json.RawMessage
	err    error
}
type handlerResult struct {
	result json.RawMessage
	err    error
}

func readFrames(ctx context.Context, reader io.Reader, events chan<- readEvent) {
	buffer := bufio.NewReaderSize(reader, readerBufferBytes)
	for {
		frame, err := readFrame(buffer)
		select {
		case events <- readEvent{frame, err}:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}

func readFrame(reader *bufio.Reader) ([]byte, error) {
	frame := make([]byte, 0, 1024)
	for {
		part, err := reader.ReadSlice('\n')
		if len(frame)+len(part) > RequestMaxBytes+1 {
			return nil, NewError(FrameTooLarge)
		}
		frame = append(frame, part...)
		if len(frame) > RequestMaxBytes && frame[len(frame)-1] != '\n' {
			return nil, NewError(FrameTooLarge)
		}
		if err == nil {
			frame = frame[:len(frame)-1]
			if len(frame) > RequestMaxBytes {
				return nil, NewError(FrameTooLarge)
			}
			return frame, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) && len(frame) > 0 {
			return nil, NewError(InvalidRequest)
		}
		return nil, err
	}
}

func invoke(handler Handler, ctx context.Context, request Request) (result json.RawMessage, err error) {
	defer func() {
		if recover() != nil {
			result = nil
			err = NewError(InternalError)
		}
	}()
	return handler(ctx, request)
}

func work(ctx context.Context, queue <-chan *job, events chan<- completion, handler Handler) {
	for {
		var next *job
		select {
		case <-ctx.Done():
			return
		case value, open := <-queue:
			if !open {
				return
			}
			next = value
		}
		if next.ctx.Err() != nil {
			continue
		}
		// The physical worker slot remains occupied until its handler returns.
		// A handler ignoring cancellation cannot create unbounded replacement work.
		done := make(chan handlerResult, 1)
		go func(request Request, requestContext context.Context) {
			result, err := invoke(handler, requestContext, request)
			done <- handlerResult{result, err}
		}(next.request, next.ctx)
		select {
		case <-ctx.Done():
			return
		case result := <-done:
			select {
			case events <- completion{next, result.result, result.err}:
			case <-ctx.Done():
				return
			}
		}
	}
}

// Serve has one response writer and bounded workers, queue, frames and session
// identities. EOF cancels outstanding reads. Noncooperative handlers cannot
// retain the writer; an arbitrary non-closeable blocked reader may outlive Serve
// but never produces output. Closeable stdio is closed on bounded shutdown.
func Serve(parent context.Context, reader io.Reader, writer io.Writer, handler Handler) error {
	if handler == nil || reader == nil || writer == nil {
		return NewError(Unavailable)
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	frames := make(chan readEvent, 1)
	completed := make(chan completion, Workers+QueueCapacity)
	queue := make(chan *job, QueueCapacity)
	responses := make(chan []byte, Workers+QueueCapacity)
	writerDone := make(chan struct{})
	var writerError error
	var writerStopped atomic.Bool
	go readFrames(ctx, reader, frames)
	go func() {
		defer close(writerDone)
		for frame := range responses {
			if writerStopped.Load() {
				return
			}
			count, err := writer.Write(frame)
			if err != nil || count != len(frame) {
				writerError = NewError(Unavailable)
				return
			}
		}
	}()
	for index := 0; index < Workers; index++ {
		go work(ctx, queue, completed, handler)
	}
	pending := make(map[string]*job)
	seen := make(map[string]bool)
	send := func(frame []byte) bool {
		timer := time.NewTimer(ShutdownTimeout)
		defer timer.Stop()
		select {
		case responses <- frame:
			return true
		case <-ctx.Done():
			return false
		case <-writerDone:
			return false
		case <-timer.C:
			return false
		}
	}
	var serveError error
	running := true
	for running {
		select {
		case <-ctx.Done():
			running = false
		case <-writerDone:
			serveError = NewError(Unavailable)
			running = false
		case event := <-completed:
			if pending[event.job.request.ID] != event.job {
				continue
			}
			delete(pending, event.job.request.ID)
			event.job.stop()
			requestError := event.err
			if event.job.ctx.Err() != nil {
				requestError = event.job.ctx.Err()
			}
			event.job.cancel()
			frame := success(event.job.request.ID, event.result)
			if requestError != nil {
				frame = failure(&event.job.request.ID, errorCode(requestError))
			}
			if !send(frame) {
				running = false
			}
		case event := <-frames:
			if event.err != nil {
				if !errors.Is(event.err, io.EOF) {
					code := errorCode(event.err)
					if code == InternalError {
						code = Unavailable
					}
					send(failure(nil, code))
					serveError = NewError(code)
				}
				running = false
				continue
			}
			frame, err := decode(event.frame)
			// A verified request identity is consumed even when its method or
			// parameters are rejected. Otherwise a malformed duplicate could
			// resolve an existing request before its actual terminal response.
			if frame.id != nil {
				id := *frame.id
				if seen[id] {
					send(failure(nil, DuplicateID))
					serveError = NewError(DuplicateID)
					running = false
					continue
				}
				if len(seen) >= MaxSessionRequests {
					send(failure(&id, SessionLimit))
					serveError = NewError(SessionLimit)
					running = false
					continue
				}
				seen[id] = true
			}
			if err != nil {
				code := errorCode(err)
				if !send(failure(frame.id, code)) {
					running = false
				}
				if frame.id == nil {
					// No trustworthy identity can own this error. End the session
					// rather than emit later results from its pending requests.
					serveError = NewError(code)
					running = false
				}
				continue
			}
			if frame.cancel != "" {
				if target := pending[frame.cancel]; target != nil {
					target.cancel()
				}
				continue
			}
			id := frame.request.ID
			requestContext, requestCancel := context.WithTimeout(ctx, frame.request.Deadline)
			next := &job{request: frame.request, ctx: requestContext, cancel: requestCancel}
			pending[id] = next
			next.stop = context.AfterFunc(requestContext, func() {
				select {
				case completed <- completion{job: next, err: requestContext.Err()}:
				case <-ctx.Done():
				}
			})
			select {
			case queue <- next:
			default:
				delete(pending, id)
				next.stop()
				next.cancel()
				if !send(failure(&id, Busy)) {
					running = false
				}
			}
		}
	}
	// Only this goroutine can enqueue responses; workers and readers have no
	// access to the writer or response channel, even after this function returns.
	cancel()
	for _, next := range pending {
		next.stop()
		next.cancel()
	}
	close(queue)
	close(responses)
	if closer, ok := reader.(io.Closer); ok {
		go func() { _ = closer.Close() }()
	}
	timer := time.NewTimer(ShutdownTimeout)
	defer timer.Stop()
	select {
	case <-writerDone:
		if serveError == nil {
			serveError = writerError
		}
	case <-timer.C:
		writerStopped.Store(true)
		if closer, ok := writer.(io.Closer); ok {
			go func() { _ = closer.Close() }()
		}
		if serveError == nil {
			serveError = NewError(Unavailable)
		}
	}
	return serveError
}
