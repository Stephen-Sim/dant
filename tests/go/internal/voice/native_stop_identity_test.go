package voice

import (
	"context"
	"errors"
	goruntime "runtime"
	"strings"
	"sync"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func awaitNativeStopMutex(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), callLifecycleIOTimeout)
	defer cancel()

	for {
		count, _ := goruntime.GoroutineProfile(nil)
		records := make([]goruntime.StackRecord, count+8)
		if count, complete := goruntime.GoroutineProfile(records); complete {
			for _, record := range records[:count] {
				frames := goruntime.CallersFrames(record.Stack())
				stop, mutex := false, false
				for {
					frame, more := frames.Next()
					stop = stop || strings.HasSuffix(frame.Function, "/voice.(*Native).stop")
					mutex = mutex ||
						strings.HasPrefix(frame.Function, "internal/sync.(*Mutex).") ||
						strings.HasPrefix(frame.Function, "sync.(*Mutex).")
					if !more {
						break
					}
				}
				if stop && mutex {
					return
				}
			}
		}

		select {
		case <-ctx.Done():
			t.Fatal("the captured old stop did not reach its serialization boundary")
		default:
			goruntime.Gosched()
		}
	}
}

func startRetainedNativeTask(t *testing.T, native *Native, worker *nativeFixtureWorker, engine *nativeFixtureEngine) {
	t.Helper()
	changed := make(chan struct{}, 16)
	native.options.Changed = func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	}
	startNativeFixture(t, native)

	worker.mu.Lock()
	worker.turns = []contracts.RawObject{object(map[string]any{"id": "retained-turn", "status": "inProgress"})}
	worker.readStatus = "active"
	worker.mu.Unlock()
	for _, event := range []runtime.Event{
		{
			Method: "turn/started",
			Params: object(map[string]any{
				"threadId": "shared-thread",
				"turn":     map[string]any{"id": "retained-turn", "status": "inProgress"},
			}),
		},
		{
			Method: "thread/realtime/itemAdded",
			Params: object(map[string]any{
				"threadId": "shared-thread",
				"item": map[string]any{
					"type":              "handoff_request",
					"handoff_id":        "retained-handoff",
					"item_id":           "retained-item",
					"input_transcript":  "A synthetic entrusted task",
					"active_transcript": []contracts.RawObject{},
				},
			}),
		},
	} {
		if err := native.HandleEvent(t.Context(), event); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), callLifecycleIOTimeout)
	defer cancel()
	for {
		engine.mu.Lock()
		adopted := len(engine.adopted) == 1
		engine.mu.Unlock()
		if adopted {
			break
		}
		select {
		case <-changed:
		case <-ctx.Done():
			t.Fatal("the synthetic acknowledged turn was not adopted")
		}
	}
}

func TestQueuedNativeStopCannotStopReplacementMediaOnTheSameSession(t *testing.T) {
	native, worker, engine, _ := nativeFixture(t)
	startRetainedNativeTask(t, native, worker, engine)
	ctx, cancel := context.WithTimeout(t.Context(), callLifecycleIOTimeout)
	defer cancel()

	ended := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce, endedOnce sync.Once
	resume := func() { releaseOnce.Do(func() { close(release) }) }
	native.setEnded(func(_ context.Context, event EndedEvent) error {
		if event.CallID == "call-one" {
			endedOnce.Do(func() {
				close(ended)
				<-release
			})
		}
		return nil
	})
	t.Cleanup(func() {
		resume()
		closing, stop := context.WithTimeout(context.Background(), callLifecycleIOTimeout)
		defer stop()
		if err := native.Close(closing); err != nil {
			t.Error("the synthetic native owner did not close", err)
		}
	})
	first := make(chan error, 1)
	go func() { first <- native.Stop(ctx, "call-one") }()
	select {
	case <-ended:
	case <-ctx.Done():
		t.Fatal("the first stop did not reach its ended callback")
	}

	stale := make(chan error, 1)
	go func() { stale <- native.Stop(ctx, "call-one") }()
	// A mutex is not durably blocked in testing/synctest. Observe this one
	// isolated wait with expanded inline frames, without emitting any stack.
	awaitNativeStopMutex(t)
	native.mu.Lock()
	original, generation := native.session, native.session.generation
	native.mu.Unlock()

	if _, err := native.Start(ctx, NativeStart{SDP: fixtureSDP, CallID: "call-two", Voice: "ember"}); err != nil {
		t.Fatal("the retained work could not reconnect its synthetic media", err)
	}
	if err := native.ConfirmConnected("call-two"); err != nil {
		t.Fatal(err)
	}
	native.mu.Lock()
	reused := native.session == original && native.session.generation == generation+1
	native.mu.Unlock()
	if !reused {
		t.Fatal("the fixture did not reconnect the same session with a new media owner")
	}
	resume()
	for _, result := range []struct {
		done <-chan error
		want error
	}{{first, nil}, {stale, ErrVoiceCancelled}} {
		select {
		case err := <-result.done:
			if !errors.Is(err, result.want) {
				t.Errorf("the captured stop returned %v, want %v", err, result.want)
			}
		case <-ctx.Done():
			t.Fatal("the captured stop did not finish")
		}
	}
	worker.mu.Lock()
	stops := 0
	for _, request := range worker.requests {
		if request == "thread/realtime/stop" {
			stops++
		}
	}
	worker.mu.Unlock()
	call := native.Call()
	if stops != 1 || call == nil || call.ID != "call-two" || call.Status != contracts.VoiceCallStatusConnected {
		t.Fatal("a queued old stop dispatched again or changed the replacement media")
	}
}

func TestCompletedIdleNativeStopCannotRetireReplacementMediaAfterItsCallback(t *testing.T) {
	native, worker, _, _ := nativeFixture(t)
	startNativeFixture(t, native)
	ctx, cancel := context.WithTimeout(t.Context(), callLifecycleIOTimeout)
	defer cancel()

	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	resume := func() { releaseOnce.Do(func() { close(release) }) }
	native.setEnded(func(_ context.Context, event EndedEvent) error {
		if event.CallID == "call-one" {
			close(entered)
			<-release
		}
		return nil
	})
	t.Cleanup(func() {
		resume()
		closing, stop := context.WithTimeout(context.Background(), callLifecycleIOTimeout)
		defer stop()
		if err := native.Close(closing); err != nil {
			t.Error("the synthetic replacement media did not close", err)
		}
	})
	stopped := make(chan error, 1)
	go func() { stopped <- native.Stop(ctx, "call-one") }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("idle media did not reach its ended callback")
	}
	native.mu.Lock()
	original, generation := native.session, native.session.generation
	owners := len(native.session.turns)
	native.mu.Unlock()
	if owners != 0 {
		t.Fatal("the fixture did not exercise the idle media retirement path")
	}

	if _, err := native.Start(ctx, NativeStart{SDP: fixtureSDP, CallID: "replacement-call", Voice: "ember"}); err != nil {
		t.Fatal("the next synthetic media did not start", err)
	}
	if err := native.ConfirmConnected("replacement-call"); err != nil {
		t.Fatal(err)
	}
	resume()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal("the already-completed old stop lost its successful result", err)
		}
	case <-ctx.Done():
		t.Fatal("the completed old stop did not return")
	}

	native.mu.Lock()
	reused := native.session == original && original.generation == generation+1
	cancelled := original.ctx.Err() != nil
	native.mu.Unlock()
	worker.mu.Lock()
	stops := 0
	for _, request := range worker.requests {
		if request == "thread/realtime/stop" {
			stops++
		}
	}
	worker.mu.Unlock()
	call := native.Call()
	if !reused || cancelled || stops != 1 || call == nil || call.ID != "replacement-call" || call.Status != contracts.VoiceCallStatusConnected {
		t.Fatal("old idle media retirement cancelled or removed its replacement owner")
	}
}

type gatedNativeContinuation struct {
	*nativeFixtureEngine
	entered chan struct{}
	release chan struct{}
}

func (engine *gatedNativeContinuation) ContinueNativeWork(work.ToolContext) error {
	close(engine.entered)
	<-engine.release
	return errors.New("synthetic continuation failure")
}

func TestLateNativeStopFailureCannotMarkReplacementMediaUnknown(t *testing.T) {
	native, worker, engine, _ := nativeFixture(t)
	gate := &gatedNativeContinuation{
		nativeFixtureEngine: engine,
		entered:             make(chan struct{}),
		release:             make(chan struct{}),
	}
	native.options.Engine = gate
	startRetainedNativeTask(t, native, worker, engine)
	ctx, cancel := context.WithTimeout(t.Context(), callLifecycleIOTimeout)
	defer cancel()
	var releaseOnce sync.Once
	resume := func() { releaseOnce.Do(func() { close(gate.release) }) }
	t.Cleanup(func() {
		resume()
		closing, stop := context.WithTimeout(context.Background(), callLifecycleIOTimeout)
		defer stop()
		if err := native.Close(closing); err != nil {
			t.Error("the synthetic replacement media did not close", err)
		}
	})
	stopped := make(chan error, 1)
	go func() { stopped <- native.Stop(ctx, "call-one") }()
	select {
	case <-gate.entered:
	case <-ctx.Done():
		t.Fatal("the old stop did not reach its retained-work handoff")
	}
	native.mu.Lock()
	original, generation := native.session, native.session.generation
	native.mu.Unlock()

	if _, err := native.Start(ctx, NativeStart{SDP: fixtureSDP, CallID: "replacement-call", Voice: "ember"}); err != nil {
		t.Fatal("the next synthetic media did not start", err)
	}
	if err := native.ConfirmConnected("replacement-call"); err != nil {
		t.Fatal(err)
	}
	resume()
	select {
	case err := <-stopped:
		if !errors.Is(err, ErrNativeStop) {
			t.Fatal("the old unconfirmed stop was misreported as successful", err)
		}
	case <-ctx.Done():
		t.Fatal("the failed old stop did not return")
	}

	native.mu.Lock()
	reused := native.session == original && original.generation == generation+1
	native.mu.Unlock()
	state := native.Snapshot()
	if !reused || state.Unknown || state.Error != nil || state.Call == nil || state.Call.ID != "replacement-call" || state.Call.Status != contracts.VoiceCallStatusConnected {
		t.Fatal("a late old stop failure poisoned the replacement media owner")
	}
}

type gatedNativeReservation struct {
	*nativeFixtureEngine
	entered chan struct{}
	release chan struct{}
}

func (engine *gatedNativeReservation) ReserveCallStart(ctx context.Context, id, provider string) (work.CallStartReservation, error) {
	close(engine.entered)
	select {
	case <-engine.release:
		return engine.nativeFixtureEngine.ReserveCallStart(ctx, id, provider)
	case <-ctx.Done():
		return work.CallStartReservation{}, ctx.Err()
	}
}

func TestNativeStartCannotPublishOrDispatchAfterCloseDuringReservation(t *testing.T) {
	native, worker, engine, _ := nativeFixture(t)
	gate := &gatedNativeReservation{
		nativeFixtureEngine: engine,
		entered:             make(chan struct{}),
		release:             make(chan struct{}),
	}
	native.options.Engine = gate
	ctx, cancel := context.WithTimeout(t.Context(), callLifecycleIOTimeout)
	defer cancel()

	var once sync.Once
	release := func() { once.Do(func() { close(gate.release) }) }
	t.Cleanup(func() {
		release()
		closing, stop := context.WithTimeout(context.Background(), callLifecycleIOTimeout)
		defer stop()
		if err := native.Close(closing); err != nil {
			t.Error("the synthetic native provider did not close", err)
		}
	})
	result := make(chan error, 1)
	go func() {
		_, err := native.Start(ctx, NativeStart{SDP: fixtureSDP, CallID: "late-call", Voice: "ember"})
		result <- err
	}()
	select {
	case <-gate.entered:
	case <-ctx.Done():
		t.Fatal("the synthetic start did not reach its reservation")
	}
	if err := native.Close(ctx); err != nil {
		t.Fatal("an unadmitted synthetic provider did not close", err)
	}
	release()
	select {
	case err := <-result:
		if !errors.Is(err, ErrVoiceClosed) {
			t.Error("a start outlived provider disposal", err)
		}
	case <-ctx.Done():
		t.Fatal("the rejected start did not finish")
	}
	worker.mu.Lock()
	requests := len(worker.requests)
	worker.mu.Unlock()
	engine.mu.Lock()
	reserved := engine.reservation.Token != ""
	engine.mu.Unlock()
	if requests != 0 || reserved || native.Call() != nil {
		t.Fatal("a disposed provider dispatched or retained the late media owner")
	}
}
