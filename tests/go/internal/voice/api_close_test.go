package voice

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestAPICloseJoinsRetiredMediaLifecycleAndConcurrentCallers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		api, socket, hangups := apiFixture(t, APIOptions{})
		entered, release := make(chan struct{}), make(chan struct{})
		var releaseOnce sync.Once
		defer releaseOnce.Do(func() { close(release) })
		var ended atomic.Int32
		api.setEnded(func(context.Context, EndedEvent) error {
			ended.Add(1)
			close(entered)
			<-release
			return nil
		})
		startAPIFixture(t, api)
		_ = socket.Close()
		<-entered
		if api.Snapshot().Call != nil {
			t.Fatal("ended media remained live while its durable lifecycle was completing")
		}
		if _, err := api.Start(t.Context(), APIStart{CallID: "next-call", SDP: fixtureSDP}); !errors.Is(err, ErrVoiceBusy) {
			t.Fatal("new media reused an unfinished lifecycle owner", err)
		}
		results := make(chan error, 2)
		for range 2 {
			go func() { results <- api.Close(t.Context()) }()
		}
		synctest.Wait()
		select {
		case err := <-results:
			t.Fatal("Close returned before its already-started lifecycle callback", err)
		default:
		}
		releaseOnce.Do(func() { close(release) })
		for range 2 {
			if err := <-results; err != nil {
				t.Fatal(err)
			}
		}
		if err := api.Close(t.Context()); err != nil || ended.Load() != 1 || hangups.Load() != 1 {
			t.Fatal("joined or repeated Close replayed media or its durable lifecycle", err)
		}
	})
}

func TestAPICancelledCloseRetainsTheOwnerForLaterConfirmation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		api, socket, hangups := apiFixture(t, APIOptions{})
		entered, release := make(chan struct{}), make(chan struct{})
		var releaseOnce sync.Once
		defer releaseOnce.Do(func() { close(release) })
		api.setEnded(func(context.Context, EndedEvent) error {
			close(entered)
			<-release
			return nil
		})
		startAPIFixture(t, api)
		_ = socket.Close()
		<-entered
		cancelled, cancel := context.WithCancel(t.Context())
		cancel()
		if err := api.Close(cancelled); !errors.Is(err, ErrVoiceHangup) {
			t.Fatal("cancelled Close fabricated a completed lifecycle", err)
		}
		joined := make(chan error, 1)
		go func() { joined <- api.Close(t.Context()) }()
		synctest.Wait()
		select {
		case err := <-joined:
			t.Fatal("later Close forgot the previous unconfirmed lifecycle", err)
		default:
		}
		releaseOnce.Do(func() { close(release) })
		if err := <-joined; err != nil || hangups.Load() != 1 {
			t.Fatal("later confirmation repeated hangup or lost completion", err)
		}
	})
}

func TestAPIEndedCallbackCannotDeadlockByClosingItsOwnOwner(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		api, socket, _ := apiFixture(t, APIOptions{})
		result := make(chan error, 1)
		api.setEnded(func(ctx context.Context, _ EndedEvent) error {
			result <- api.Close(ctx)
			return nil
		})
		startAPIFixture(t, api)
		_ = socket.Close()
		if err := <-result; !errors.Is(err, ErrVoiceHangup) {
			t.Fatal("an owner claimed that it had joined itself", err)
		}
		if err := api.Close(t.Context()); err != nil {
			t.Fatal("external Close could not confirm the now-completed callback", err)
		}
	})
}

func TestAPICloseDeadlineDoesNotForgetItsPendingLifecycle(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		api, socket, _ := apiFixture(t, APIOptions{})
		entered, release := make(chan struct{}), make(chan struct{})
		var releaseOnce sync.Once
		defer releaseOnce.Do(func() { close(release) })
		api.setEnded(func(context.Context, EndedEvent) error {
			close(entered)
			<-release
			return nil
		})
		startAPIFixture(t, api)
		_ = socket.Close()
		<-entered
		deadline, cancel := context.WithTimeout(t.Context(), time.Millisecond)
		defer cancel()
		if err := api.Close(deadline); !errors.Is(err, ErrVoiceHangup) {
			t.Fatal("expired shutdown budget was reported confirmed", err)
		}
		joined := make(chan error, 1)
		go func() { joined <- api.Close(t.Context()) }()
		synctest.Wait()
		select {
		case err := <-joined:
			t.Fatal("timed-out Close removed a still-running owner", err)
		default:
		}
		releaseOnce.Do(func() { close(release) })
		if err := <-joined; err != nil {
			t.Fatal(err)
		}
	})
}

func TestAPICloseRetainsAnUnconfirmedDurableLifecycleResult(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		api, socket, hangups := apiFixture(t, APIOptions{})
		api.setEnded(func(context.Context, EndedEvent) error { return ErrCallLifecycle })
		startAPIFixture(t, api)
		_ = socket.Close()
		synctest.Wait()
		if _, err := api.Start(t.Context(), APIStart{CallID: "after-unconfirmed", SDP: fixtureSDP}); !errors.Is(err, ErrVoiceBusy) {
			t.Fatal("unconfirmed cleanup permitted a replacement media action", err)
		}
		for range 2 {
			if err := api.Close(t.Context()); !errors.Is(err, ErrCallLifecycle) {
				t.Fatal("completed cleanup erased an unconfirmed durable lifecycle", err)
			}
		}
		if snapshot := api.Snapshot(); snapshot.Error == nil || *snapshot.Error != ErrCallLifecycle.Error() || hangups.Load() != 1 {
			t.Fatal("unconfirmed lifecycle was hidden or its media action was replayed")
		}
	})
}

func TestAPIEndedFailureIsPublishedBeforeItsChangeNotification(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		observed := make(chan struct{}, 1)
		var api *API
		options := APIOptions{Changed: func() {
			if snapshot := api.Snapshot(); snapshot.Error != nil && *snapshot.Error == ErrCallLifecycle.Error() {
				select {
				case observed <- struct{}{}:
				default:
				}
			}
		}}
		var socket *fakeVoiceSocket
		api, socket, _ = apiFixture(t, options)
		api.setEnded(func(context.Context, EndedEvent) error { return ErrCallLifecycle })
		startAPIFixture(t, api)
		_ = socket.Close()
		synctest.Wait()
		select {
		case <-observed:
		default:
			t.Fatal("terminal lifecycle error was published after its final change notification")
		}
	})
}
