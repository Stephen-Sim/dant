package work

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type persistedStreamWorker struct {
	*fakeWorker
	rpc *workerRuntime.RPC
}

type persistedStreamExpectation struct {
	messageID string
	text      string
	units     int
	digest    [sha256.Size]byte
}

type persistedStreamWriteProgress struct {
	units          int
	digest         [sha256.Size]byte
	expectedPrefix bool
}

type persistedStreamObservation struct {
	messageID string
	err       error
}

func (worker *persistedStreamWorker) Request(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
	return worker.rpc.Request(ctx, method, params)
}

func (worker *persistedStreamWorker) RequestGuarded(ctx context.Context, method string, params contracts.RawObject, guard func() error) (contracts.RawObject, error) {
	return worker.rpc.RequestGuarded(ctx, method, params, guard)
}

func (worker *persistedStreamWorker) SubscribeEvents() (<-chan workerRuntime.Event, func(), error) {
	return worker.rpc.SubscribeEvents()
}

func (worker *persistedStreamWorker) Snapshot() contracts.WorkerState {
	if worker.rpc.Closed() {
		return contracts.WorkerState{Status: contracts.ConnectionStatusOffline}
	}
	return contracts.WorkerState{Status: contracts.ConnectionStatusOnline}
}

func TestRPCStreamPersistsCompleteOwnedTextDespiteSlowLargeHistoryWrites(t *testing.T) {
	for _, paused := range []bool{false, true} {
		name := "completed provider turn"
		if paused {
			name = "explicit pause waits for interrupted provider turn"
		}
		t.Run(name, func(t *testing.T) {
			started := time.Now()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			blocked, release := make(chan struct{}), make(chan struct{})
			var armed atomic.Bool
			var expectedWrite atomic.Pointer[persistedStreamExpectation]
			var lastWrite atomic.Pointer[persistedStreamWriteProgress]
			var observedWrite atomic.Bool
			var attemptedWrites, atomicWrites, decodedWrites atomic.Int64
			durable := make(chan persistedStreamObservation, 1)
			reportProgress := func(phase string) {
				t.Helper()
				var actual persistedStreamWriteProgress
				if value := lastWrite.Load(); value != nil {
					actual = *value
				}
				var expected persistedStreamExpectation
				if value := expectedWrite.Load(); value != nil {
					expected = *value
				}
				t.Logf("stream fixture phase=%s elapsed=%s attemptedWrites=%d atomicWrites=%d decodedWrites=%d actualUTF16=%d expectedUTF16=%d actualSHA256=%x expectedSHA256=%x expectedPrefix=%t",
					phase, time.Since(started).Round(time.Millisecond), attemptedWrites.Load(), atomicWrites.Load(), decodedWrites.Load(),
					actual.units, expected.units, actual.digest, expected.digest, actual.expectedPrefix)
			}
			var releaseOnce sync.Once
			releaseWrite := func() { releaseOnce.Do(func() { close(release) }) }
			defer releaseWrite()
			persistence, err := store.Open(t.TempDir(), store.Options{
				Write: func(ctx context.Context, path string, data []byte, mode fs.FileMode) error {
					attemptedWrites.Add(1)
					if armed.CompareAndSwap(true, false) {
						close(blocked)
						select {
						case <-release:
						case <-ctx.Done():
							return ctx.Err()
						}
					}
					if err := files.WriteAtomic(ctx, path, data, mode); err != nil {
						return err
					}
					atomicWrites.Add(1)
					// Observe the successful durable write without repeatedly cloning
					// the entire large Store snapshot while the stream is draining.
					want := expectedWrite.Load()
					if want != nil && !observedWrite.Load() {
						var saved struct {
							Messages []struct {
								ID     string         `json:"id"`
								Role   contracts.Role `json:"role"`
								Text   string         `json:"text"`
								TaskID string         `json:"taskId"`
							} `json:"messages"`
						}
						err := json.Unmarshal(data, &saved)
						decodedWrites.Add(1)
						matchedID := ""
						for _, message := range saved.Messages {
							if message.Role == contracts.RoleAssistant && message.TaskID == want.messageID {
								progress := &persistedStreamWriteProgress{
									units: contracts.UTF16Length(message.Text), digest: sha256.Sum256([]byte(message.Text)),
									expectedPrefix: strings.HasPrefix(want.text, message.Text),
								}
								lastWrite.Store(progress)
								if !progress.expectedPrefix {
									err = fmt.Errorf("owned stream no longer matches its expected prefix")
								} else if message.Text == want.text {
									matchedID = message.ID
								}
							}
						}
						if (err != nil || matchedID != "") && observedWrite.CompareAndSwap(false, true) {
							durable <- persistedStreamObservation{messageID: matchedID, err: err}
						}
					}
					return nil
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			defer persistence.Close()
			const (
				historyCount       = 128
				historyTextBytes   = 8 * 1024
				minimumHistorySize = 1024 * 1024
			)
			if err := persistence.Mutate(ctx, func(state *contracts.State) error {
				for index := range historyCount {
					state.Messages = append(state.Messages, &contracts.ChatMessage{
						ID: store.UUID(), Role: contracts.RoleAssistant,
						Text:   fmt.Sprintf("synthetic archive %d: ", index) + strings.Repeat("h", historyTextBytes),
						Time:   contracts.Some(float64(1_700_000_000_000 + index)),
						Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)),
					})
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			history, _ := json.Marshal(persistence.Snapshot().Messages)
			if len(history) < minimumHistorySize {
				t.Fatal("synthetic persistence fixture did not contain a substantial history")
			}
			reportProgress("history-ready")

			inputReader, input := io.Pipe()
			output, producer := io.Pipe()
			client, err := workerRuntime.NewRPC(ctx, input, output, nil)
			if err != nil {
				t.Fatal(err)
			}
			requests := make(chan contracts.RawObject, 8)
			readerDone := make(chan struct{})
			go func() {
				defer close(readerDone)
				scanner := bufio.NewScanner(inputReader)
				scanner.Buffer(make([]byte, 4096), workerRuntime.MaxRPCFrameBytes+1)
				for scanner.Scan() {
					request, err := contracts.DecodeObject(scanner.Bytes(), workerRuntime.MaxRPCFrameBytes)
					if err != nil {
						return
					}
					select {
					case requests <- request:
					case <-ctx.Done():
						return
					}
				}
			}()
			worker := &persistedStreamWorker{fakeWorker: &fakeWorker{root: t.TempDir()}, rpc: client}
			engine, err := New(ctx, persistence, worker, Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				releaseWrite()
				cancel()
				client.Close()
				_ = inputReader.Close()
				_ = producer.Close()
				_ = engine.Close()
				<-client.Done()
				<-readerDone
			}()
			next := func(method string, timeout time.Duration) contracts.RawObject {
				t.Helper()
				deadline := time.NewTimer(timeout)
				defer deadline.Stop()
				select {
				case request := <-requests:
					if eventString(request, "method") != method {
						t.Fatalf("expected %s, received %s", method, eventString(request, "method"))
					}
					return request
				case <-deadline.C:
					reportProgress("request-timeout")
					t.Fatalf("RPC request %s did not reach the isolated provider", method)
					return nil
				}
			}
			send := func(object contracts.RawObject) error {
				_, err := producer.Write(append(raw(object), '\n'))
				return err
			}
			reply := func(request, result contracts.RawObject) {
				t.Helper()
				if err := send(contracts.RawObject{"id": request["id"], "result": raw(result)}); err != nil {
					t.Fatal("provider response failed", err)
				}
			}
			message, err := persistence.Add(ctx, &contracts.ChatMessage{Role: contracts.RoleUser, Text: "isolated streamed response"})
			if err != nil || engine.Enqueue(ctx, message) != nil {
				t.Fatal("fixture work was not admitted", err)
			}
			// Preparing the real large-history store is setup, outside the stream
			// responsiveness checks below. Race instrumentation can make those
			// clones and atomic writes slower than the measured burst itself.
			reply(next("thread/start", workerRuntime.RequestTimeout), contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})})
			const turnID = "persisted-stream-turn"
			reply(next("turn/start", workerRuntime.RequestTimeout), contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw(turnID)})})
			owner := waitToolScope(t, engine, turnID)
			reportProgress("turn-ready")
			notification := func(method string, params contracts.RawObject) error {
				params["threadId"], params["turnId"] = raw(owner.ThreadID), raw(owner.TurnID)
				return send(contracts.RawObject{"method": raw(method), "params": raw(params)})
			}
			delta := func(text string) error {
				return notification("item/agentMessage/delta", contracts.RawObject{"itemId": raw("owned-stream-item"), "delta": raw(text)})
			}
			armed.Store(true)
			if err := delta("begin:"); err != nil {
				t.Fatal(err)
			}
			select {
			case <-blocked:
				reportProgress("write-blocked")
			case <-time.After(5 * time.Second):
				reportProgress("write-block-timeout")
				t.Fatal("stream did not reach the real store write boundary")
			}

			probe := make(chan error, 1)
			go func() {
				_, err := client.Request(ctx, "fixture/read", nil)
				probe <- err
			}()
			probeRequest := next("fixture/read", 5*time.Second)
			pieces := []string{"A", "中", "😀", "e\u0301", "\n"}
			var expected strings.Builder
			expected.WriteString("begin:")
			const deltaCount = 4096
			for index := range deltaCount {
				expected.WriteString(pieces[index%len(pieces)])
			}
			flood := make(chan error, 1)
			go func() {
				for index := range deltaCount {
					if index == deltaCount/2 {
						foreign := contracts.RawObject{
							"threadId": raw(owner.ThreadID), "turnId": raw("foreign-stream-turn"),
							"itemId": raw("owned-stream-item"), "delta": raw("FOREIGN"),
						}
						if err := send(contracts.RawObject{"method": raw("item/agentMessage/delta"), "params": raw(foreign)}); err != nil {
							flood <- err
							return
						}
					}
					if err := delta(pieces[index%len(pieces)]); err != nil {
						flood <- err
						return
					}
				}
				flood <- nil
			}()
			select {
			case err := <-flood:
				if err != nil {
					select {
					case rpcErr := <-probe:
						t.Fatal("adjacent provider text disconnected while store persistence was delayed", err, rpcErr)
					case <-time.After(time.Second):
						t.Fatal("adjacent provider text disconnected while store persistence was delayed", err)
					}
				}
			case <-time.After(5 * time.Second):
				reportProgress("reader-flood-timeout")
				t.Fatal("slow persistence blocked the RPC reader")
			}
			reply(probeRequest, contracts.RawObject{"ok": raw(true)})
			select {
			case err := <-probe:
				if err != nil {
					t.Fatal("stream backlog prevented a provider RPC response", err)
				}
			case <-time.After(3 * time.Second):
				reportProgress("response-timeout")
				t.Fatal("RPC response waited for the blocked store consumer")
			}
			if client.Closed() {
				t.Fatal("valid adjacent text was treated as an uncertain executor disconnect")
			}
			reportProgress("reader-responsive")
			expectedText := expected.String()
			expectedWrite.Store(&persistedStreamExpectation{messageID: message.ID, text: expectedText,
				units: contracts.UTF16Length(expectedText), digest: sha256.Sum256([]byte(expectedText))})
			releaseWrite()
			reportProgress("drain-released")
			var observed persistedStreamObservation
			select {
			case observed = <-durable:
				if observed.err != nil {
					reportProgress("durable-observation-failed")
					t.Fatal("the real durable stream write could not be observed", observed.err)
				}
			case <-ctx.Done():
				t.Fatal("stream persistence observation was cancelled", ctx.Err())
			// Eventual full-state persistence has its own instrumented-work allowance.
			// The blocked reader/probe/interrupt and response bounds above stay short.
			case <-time.After(workerRuntime.RequestTimeout):
				reportProgress("durable-timeout")
				t.Fatal("complete owned text did not reach the real atomic write")
			}
			if state := engine.Snapshot(); state.Active == nil || state.Executor.Paused || state.Active.TurnID.Value != owner.TurnID {
				t.Fatal("streaming text changed execution ownership or introduced a pause")
			}
			streamed, err := persistence.Message(observed.messageID)
			if err != nil || streamed.Role != contracts.RoleAssistant || streamed.TaskID.Value != message.ID || streamed.Text != expected.String() || streamed.Status.Value != contracts.MessageStatusStreaming {
				t.Fatal("owned streaming text was not committed before the provider completion", err)
			}
			reportProgress("stream-durable")

			pauseResult := make(chan error, 1)
			if paused {
				go func() { pauseResult <- engine.Pause(ctx) }()
				interrupt := next("turn/interrupt", 5*time.Second)
				params, err := contracts.DecodeObject(interrupt["params"], 4096)
				if err != nil || eventString(params, "turnId") != owner.TurnID || eventString(params, "threadId") != owner.ThreadID {
					t.Fatal("pause interrupted a different execution owner", err)
				}
				reply(interrupt, contracts.RawObject{})
				select {
				case <-pauseResult:
					t.Fatal("interrupt acknowledgement was mistaken for provider termination")
				default:
				}
			}
			if err := notification("item/completed", contracts.RawObject{"item": raw(contracts.RawObject{
				"id": raw("owned-stream-item"), "type": raw("agentMessage"), "text": raw(expected.String()),
			})}); err != nil {
				t.Fatal(err)
			}
			providerStatus := "completed"
			if paused {
				providerStatus = "interrupted"
			}
			if err := notification("turn/completed", contracts.RawObject{"turn": raw(contracts.RawObject{
				"id": raw(owner.TurnID), "status": raw(providerStatus),
			})}); err != nil {
				t.Fatal(err)
			}
			if paused {
				if err := awaitWorkAction(t, pauseResult); err != nil {
					t.Fatal(err)
				}
			}
			waitSnapshot(t, engine, func(state Snapshot) bool { return state.Active == nil && !state.Finishing })
			reportProgress("terminal-observed")
			state := persistence.Snapshot()
			preserved, _ := json.Marshal(state.Messages[:historyCount])
			if !bytes.Equal(history, preserved) || len(state.Messages) != historyCount+2 {
				t.Fatal("stream delivery rewrote history or created duplicate assistant messages")
			}
			assistant := state.Messages[len(state.Messages)-1]
			if assistant.Role != contracts.RoleAssistant || assistant.TaskID.Value != message.ID || assistant.Text != expected.String() || assistant.Status.Value != contracts.MessageStatus(contracts.TaskStatusCompleted) || assistant.Read {
				t.Fatal("completed stream lost exact text, owner, completion or unread delivery state")
			}
			stored, err := persistence.Message(message.ID)
			want := contracts.TaskStatusReview
			if paused {
				want = contracts.TaskStatusPaused
			}
			if err != nil || stored.Status.Value != contracts.MessageStatus(want) || stored.TurnID.Value != owner.TurnID || stored.UnknownOutcome || stored.Submission.Value != contracts.SubmissionStatusConfirmed || engine.Snapshot().Executor.Paused != paused {
				t.Fatal("provider terminal changed durable pause or uncertainty semantics", err)
			}
			if paused && stored.PauseReason.Value != pauseReasonUser {
				t.Fatal("confirmed explicit pause lost its human pause reason")
			}
			if err := persistence.MarkVisible(ctx, []string{assistant.ID}, nil); err != nil {
				t.Fatal(err)
			}
			seen, err := persistence.Message(assistant.ID)
			if err != nil || !seen.Read || !seen.VisibleAt.Present || seen.Text != expected.String() {
				t.Fatal("exact streamed output did not retain its ordinary read receipt", err)
			}
			select {
			case request := <-requests:
				t.Fatalf("terminal stream unexpectedly replayed work: %s", eventString(request, "method"))
			default:
			}
			reportProgress("complete")
		})
	}
}
