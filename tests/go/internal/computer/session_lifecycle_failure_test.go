package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestComputerSessionRejectsLateAcquireAndReleaseRepliesAfterJoinedClosure(t *testing.T) {
	for _, stopAt := range []string{"acquire", "release"} {
		t.Run(stopAt, func(t *testing.T) {
			engine := &controlEngineFixture{}
			var session *ComputerSession
			closed := make(chan struct{})
			guest := guestFixture(func(ctx context.Context, _ string, raw json.RawMessage) (*http.Response, error) {
				var request struct {
					Action string `json:"action"`
				}
				_ = json.Unmarshal(raw, &request)
				if request.Action == stopAt {
					go func() { session.Close(); close(closed) }()
					<-ctx.Done()
				}
				return controlFixture(request.Action, "captured-lease", 1000), nil
			})
			var err error
			session, err = NewComputerSession(t.Context(), engine, guest, SessionOptions{Now: func() time.Time { return time.UnixMilli(100) }})
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			_, err = session.Acquire(t.Context())
			if stopAt == "release" {
				if err != nil {
					t.Fatal(err)
				}
				_, err = session.Release(t.Context(), "captured-lease")
			}
			if !errors.Is(err, ErrControlExpired) {
				t.Fatal("late guest reply acquired authority after closure", err)
			}
			<-closed
			if _, err := session.Acquire(t.Context()); !errors.Is(err, ErrControlBusy) {
				t.Fatal("closed control owner accepted a new acquire", err)
			}
		})
	}
}

func TestComputerSessionConcurrentReleaseAndFailedInputCannotRenewOrRepeatGuestActions(t *testing.T) {
	engine := &controlEngineFixture{}
	entered, release := make(chan struct{}), make(chan struct{})
	var guestReleases atomic.Int32
	guest := guestFixture(func(ctx context.Context, route string, raw json.RawMessage) (*http.Response, error) {
		if route == "/input" {
			return nil, io.ErrUnexpectedEOF
		}
		var request struct {
			Action string `json:"action"`
		}
		_ = json.Unmarshal(raw, &request)
		if request.Action == "release" {
			guestReleases.Add(1)
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return controlFixture(request.Action, "captured-lease", 1000), nil
	})
	session, err := NewComputerSession(t.Context(), engine, guest, SessionOptions{Now: func() time.Time { return time.UnixMilli(100) }})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if _, err := session.Acquire(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := session.Input(t.Context(), json.RawMessage(`{"sessionId":"captured-lease","type":"click"}`)); !errors.Is(err, ErrControlUnconfirmed) || session.Snapshot().ExpiresAt != 1000 {
		t.Fatal("failed guest input renewed a lease or became confirmed", err)
	}
	finished := make(chan error, 1)
	go func() { _, err := session.Release(t.Context(), "captured-lease"); finished <- err }()
	<-entered
	if _, err := session.Release(t.Context(), "captured-lease"); !errors.Is(err, ErrControlBusy) {
		t.Fatal("concurrent release repeated a guest action", err)
	}
	if _, err := session.Acquire(t.Context()); !errors.Is(err, ErrControlBusy) {
		t.Fatal("pending release admitted a new control owner", err)
	}
	close(release)
	if err := <-finished; err != nil || guestReleases.Load() != 1 {
		t.Fatal("owned release failed or repeated", err)
	}
}

func TestComputerSessionConfirmationExpiredDuringTransportCannotRestoreHumanControl(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		engine := &controlEngineFixture{}
		guest := guestFixture(func(_ context.Context, _ string, raw json.RawMessage) (*http.Response, error) {
			var request struct {
				Action string `json:"action"`
			}
			_ = json.Unmarshal(raw, &request)
			expires := float64(time.Now().Add(time.Second).UnixMilli())
			if request.Action == "confirm" {
				time.Sleep(2 * time.Second)
				expires = float64(time.Now().Add(time.Second).UnixMilli())
			}
			return controlFixture(request.Action, "expiring-lease", expires), nil
		})
		session, err := NewComputerSession(t.Context(), engine, guest, SessionOptions{})
		if err != nil {
			t.Fatal(err)
		}
		defer session.Close()
		if _, err := session.Acquire(t.Context()); !errors.Is(err, ErrControlExpired) || session.Snapshot().SessionID != nil {
			t.Fatal("expired transport reply revived a lease", err)
		}
	})
}

func TestComputerSessionForwardClockJumpExpiresItsLeaseWithABoundedTimer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var now atomic.Int64
		now.Store(100)
		engine := &controlEngineFixture{}
		guest := guestFixture(func(_ context.Context, _ string, raw json.RawMessage) (*http.Response, error) {
			var request struct {
				Action string `json:"action"`
			}
			_ = json.Unmarshal(raw, &request)
			return controlFixture(request.Action, "clock-jump-lease", 1000), nil
		})
		session, err := NewComputerSession(t.Context(), engine, guest, SessionOptions{Now: func() time.Time { return time.UnixMilli(now.Load()) }})
		if err != nil {
			t.Fatal(err)
		}
		defer session.Close()
		if _, err := session.Acquire(t.Context()); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		now.Store(10000)
		session.changed()
		synctest.Wait()
		time.Sleep(time.Millisecond)
		synctest.Wait()
		if session.Snapshot().SessionID != nil {
			t.Fatal("clock jump retained an expired lease")
		}
	})
}
