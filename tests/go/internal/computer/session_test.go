package computer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type controlEngineFixture struct {
	mu                       sync.Mutex
	begun, acquired          bool
	begins, aborts, releases int
	call                     *contracts.Call
}

func (engine *controlEngineFixture) BeginComputerAcquire() error {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.call != nil || engine.begun || engine.acquired {
		return ErrControlBusy
	}
	engine.begun = true
	engine.begins++
	return nil
}

func (engine *controlEngineFixture) AbortComputerAcquire() {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	engine.begun = false
	engine.aborts++
}

func (engine *controlEngineFixture) Acquire(context.Context) error {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if !engine.begun {
		return ErrControlBusy
	}
	engine.begun = false
	engine.acquired = true
	return nil
}

func (engine *controlEngineFixture) Release() error {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	engine.begun = false
	engine.acquired = false
	engine.releases++
	return nil
}

func (engine *controlEngineFixture) CallSnapshot() *contracts.Call {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	return engine.call
}

type guestFixture func(context.Context, string, json.RawMessage) (*http.Response, error)

func (guest guestFixture) Guest(ctx context.Context, route string, body json.RawMessage) (*http.Response, error) {
	return guest(ctx, route, body)
}

func guestResult(value any) *http.Response {
	raw, _ := json.Marshal(value)
	return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw))}
}

func controlFixture(action, id string, expires float64) *http.Response {
	if action == "release" {
		return guestResult(Control{Status: contracts.ComputerControlStatusDant})
	}
	status := contracts.ComputerControlStatusTakingOver
	if action == "confirm" {
		status = contracts.ComputerControlStatusHuman
	}

	return guestResult(Control{Status: status, SessionID: &id, ExpiresAt: expires})
}

func TestComputerSessionFencesLeaseAndReleasesOnlyExactIdentity(t *testing.T) {
	engine := &controlEngineFixture{}
	calls := []string{}
	guest := guestFixture(func(ctx context.Context, route string, raw json.RawMessage) (*http.Response, error) {
		var body struct{ Action, SessionID string }
		json.Unmarshal(raw, &body)
		calls = append(calls, body.Action)
		return controlFixture(body.Action, "fixture-lease", float64(time.Now().Add(time.Minute).UnixMilli())), nil
	})
	session, err := NewComputerSession(context.Background(), engine, guest, SessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	state, err := session.Acquire(context.Background())
	if err != nil || state.Status != contracts.ComputerControlStatusHuman || session.Pending() {
		t.Fatal("lease was not confirmed")
	}

	if _, err := session.Release(context.Background(), "another"); !errors.Is(err, ErrControlExpired) {
		t.Fatal("foreign lease release admitted")
	}

	if len(calls) != 2 {
		t.Fatal("foreign release reached guest")
	}
	released, err := session.Release(context.Background(), "fixture-lease")
	if err != nil || released.SessionID != nil || engine.releases != 1 {
		t.Fatal("exact lease not released")
	}
	engine.call = &contracts.Call{ID: "call"}
	if _, err := session.Acquire(context.Background()); !errors.Is(err, ErrControlBusy) {
		t.Fatal("takeover admitted during a call")
	}
}

func TestComputerSessionLateInputCannotRenewAnotherLease(t *testing.T) {
	engine := &controlEngineFixture{}
	var acquired atomic.Int32
	inputStarted := make(chan struct{})
	inputRelease := make(chan struct{})
	guest := guestFixture(func(ctx context.Context, route string, raw json.RawMessage) (*http.Response, error) {
		if route == "/input" {
			close(inputStarted)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-inputRelease:
			}
			return guestResult(struct {
				ExpiresAt float64 `json:"expiresAt"`
			}{float64(time.Now().Add(time.Hour).UnixMilli())}), nil
		}
		var body struct{ Action string }
		json.Unmarshal(raw, &body)
		id := "first"
		if body.Action == "acquire" {
			acquired.Add(1)
		}
		if acquired.Load() > 1 {
			id = "second"
		}
		return controlFixture(body.Action, id, float64(time.Now().Add(time.Minute).UnixMilli())), nil
	})
	session, _ := NewComputerSession(context.Background(), engine, guest, SessionOptions{})
	defer session.Close()
	if _, err := session.Acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := session.Input(context.Background(), json.RawMessage(`{"sessionId":"first","action":"move","x":1,"y":1}`))
		done <- err
	}()
	<-inputStarted
	if _, err := session.Release(context.Background(), "first"); err != nil {
		t.Fatal(err)
	}
	second, err := session.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	close(inputRelease)
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	if actual := session.Snapshot(); actual.SessionID == nil || *actual.SessionID != "second" || actual.ExpiresAt != second.ExpiresAt {
		t.Fatal("late input renewed a different lease")
	}
}

func TestComputerSessionFailedConfirmationClearsTakeoverWithoutResumingWork(t *testing.T) {
	engine := &controlEngineFixture{}
	released := false
	guest := guestFixture(func(ctx context.Context, route string, raw json.RawMessage) (*http.Response, error) {
		var body struct{ Action string }
		json.Unmarshal(raw, &body)
		if body.Action == "confirm" {
			return nil, io.ErrUnexpectedEOF
		}
		if body.Action == "release" {
			released = true
		}
		return controlFixture(body.Action, "fixture", float64(time.Now().Add(time.Minute).UnixMilli())), nil
	})
	session, _ := NewComputerSession(context.Background(), engine, guest, SessionOptions{})
	defer session.Close()
	if _, err := session.Acquire(context.Background()); !errors.Is(err, ErrControlUnconfirmed) {
		t.Fatal("unconfirmed lease reported human control")
	}

	if session.Pending() || session.Snapshot().SessionID != nil || engine.acquired || engine.aborts != 1 || engine.releases != 1 || !released {
		t.Fatal("failed confirmation left local takeover active")
	}
}

func TestComputerSessionCloseCancelsAndJoinsPendingGuest(t *testing.T) {
	started := make(chan struct{})
	guest := guestFixture(func(ctx context.Context, route string, body json.RawMessage) (*http.Response, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	session, _ := NewComputerSession(context.Background(), &controlEngineFixture{}, guest, SessionOptions{})
	done := make(chan struct{})
	go func() { defer close(done); _, _ = session.Acquire(context.Background()) }()
	<-started
	session.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("close returned before pending guest joined")
	}
}
