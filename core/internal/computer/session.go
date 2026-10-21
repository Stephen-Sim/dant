package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const controlExpiryGrace = 20 * time.Millisecond
const controlInputTTL = 120 * time.Second
const controlResultLimit = 1024 * 1024

var ErrControlBusy = errors.New("desktop_control_busy")
var ErrControlExpired = errors.New("desktop_control_expired")
var ErrControlUnconfirmed = errors.New("desktop_control_unconfirmed")

type Control struct {
	Status    contracts.ComputerControlStatus `json:"status"`
	SessionID *string                         `json:"sessionId"`
	ExpiresAt float64                         `json:"expiresAt"`
}

type ControlEngine interface {
	BeginComputerAcquire() error
	AbortComputerAcquire()
	Acquire(context.Context) error
	Release() error
	CallSnapshot() *contracts.Call
}

type GuestWorker interface {
	Guest(context.Context, string, json.RawMessage) (*http.Response, error)
}

type SessionOptions struct {
	Now     func() time.Time
	Changed func()
}

type ComputerSession struct {
	mu              sync.Mutex
	ctx             context.Context
	cancel          context.CancelFunc
	engine          ControlEngine
	worker          GuestWorker
	options         SessionOptions
	state           Control
	pending, closed bool
	epoch           uint64
	wake            chan struct{}
	wg              sync.WaitGroup
	operations      sync.WaitGroup
}

func NewComputerSession(ctx context.Context, engine ControlEngine, worker GuestWorker, options SessionOptions) (*ComputerSession, error) {
	if ctx == nil || engine == nil || worker == nil {
		return nil, ErrControlUnconfirmed
	}

	if options.Now == nil {
		options.Now = time.Now
	}

	if options.Changed == nil {
		options.Changed = func() {}
	}
	owner, cancel := context.WithCancel(ctx)
	session := &ComputerSession{ctx: owner, cancel: cancel, engine: engine, worker: worker, options: options, state: Control{Status: contracts.ComputerControlStatusDant}, wake: make(chan struct{}, 1)}
	session.wg.Add(1)
	go session.expirations()
	return session, nil
}

func (session *ComputerSession) Snapshot() Control {
	session.mu.Lock()
	defer session.mu.Unlock()
	copy := session.state
	if copy.SessionID != nil {
		id := *copy.SessionID
		copy.SessionID = &id
	}

	return copy
}

func (session *ComputerSession) Pending() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.pending
}

func (session *ComputerSession) changed() {
	select {
	case session.wake <- struct{}{}:
	default:
	}
	session.options.Changed()
}

func (session *ComputerSession) begin(ctx context.Context) (context.Context, func(), error) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return nil, nil, ErrControlBusy
	}
	session.operations.Add(1)
	session.mu.Unlock()
	owner, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(session.ctx, cancel)
	return owner, func() {
		stop()
		cancel()
		session.operations.Done()
	}, nil
}

func (session *ComputerSession) guestJSON(ctx context.Context, route string, body json.RawMessage) (contracts.RawObject, error) {
	response, err := session.worker.Guest(ctx, route, body)
	if err != nil {
		return nil, ErrControlUnconfirmed
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, controlResultLimit+1))
	if err != nil || len(raw) > controlResultLimit || response.StatusCode != http.StatusOK {
		return nil, ErrControlUnconfirmed
	}
	object, err := contracts.DecodeObject(raw, controlResultLimit)
	if err != nil {
		return nil, ErrControlUnconfirmed
	}

	return object, nil
}

func (session *ComputerSession) control(ctx context.Context, action string, id *string) (Control, error) {
	body, _ := json.Marshal(struct {
		Action    string  `json:"action"`
		SessionID *string `json:"sessionId,omitempty"`
	}{action, id})
	object, err := session.guestJSON(ctx, "/control", body)
	if err != nil {
		return Control{}, err
	}
	raw, _ := json.Marshal(object)
	var result Control
	if json.Unmarshal(raw, &result) != nil || !result.Status.Valid() || math.IsNaN(result.ExpiresAt) || math.IsInf(result.ExpiresAt, 0) || result.ExpiresAt < 0 || result.ExpiresAt > 9007199254740991 || object["sessionId"] == nil || object["expiresAt"] == nil {
		return Control{}, ErrControlUnconfirmed
	}

	if result.SessionID != nil && (*result.SessionID == "" || len(*result.SessionID) > 256) {
		return Control{}, ErrControlUnconfirmed
	}

	return result, nil
}

func (session *ComputerSession) Acquire(ctx context.Context) (result Control, err error) {
	owner, done, err := session.begin(ctx)
	if err != nil {
		return Control{}, err
	}
	defer done()
	session.mu.Lock()
	if session.pending || session.state.SessionID != nil {
		session.mu.Unlock()
		return Control{}, ErrControlBusy
	}
	session.pending = true
	session.epoch++
	epoch := session.epoch
	session.mu.Unlock()
	defer func() {
		session.mu.Lock()
		session.pending = false
		session.mu.Unlock()
		session.changed()
	}()
	if err := session.engine.BeginComputerAcquire(); err != nil {
		return Control{}, err
	}
	engineAcquired := false
	defer func() {
		if err != nil {
			if engineAcquired {
				_ = session.engine.Release()
			}
			session.engine.AbortComputerAcquire()
		}
	}()
	acquired, err := session.control(owner, "acquire", nil)
	if err != nil {
		return Control{}, err
	}

	if acquired.SessionID == nil || acquired.ExpiresAt <= float64(session.options.Now().UnixMilli()) {
		return Control{}, ErrControlUnconfirmed
	}
	session.mu.Lock()
	if session.closed || session.epoch != epoch {
		session.mu.Unlock()
		return Control{}, ErrControlExpired
	}
	session.state = acquired
	session.mu.Unlock()
	session.changed()
	defer func() {
		if err == nil {
			return
		}
		recovery, stop := context.WithTimeout(context.WithoutCancel(owner), 2*time.Second)
		defer stop()
		_, _ = session.control(recovery, "release", acquired.SessionID)
		session.mu.Lock()
		if session.epoch == epoch {
			session.state = Control{Status: contracts.ComputerControlStatusDant}
			session.epoch++
		}
		session.mu.Unlock()
		session.changed()
	}()
	if err := session.engine.Acquire(owner); err != nil {
		return Control{}, err
	}
	engineAcquired = true
	confirmed, err := session.control(owner, "confirm", acquired.SessionID)
	if err != nil {
		return Control{}, err
	}

	if confirmed.Status != contracts.ComputerControlStatusHuman || confirmed.SessionID == nil || *confirmed.SessionID != *acquired.SessionID || confirmed.ExpiresAt <= float64(session.options.Now().UnixMilli()) {
		return Control{}, ErrControlUnconfirmed
	}
	session.mu.Lock()
	if session.closed || session.epoch != epoch {
		session.mu.Unlock()
		return Control{}, ErrControlExpired
	}
	session.state = confirmed
	session.mu.Unlock()
	session.changed()
	return session.Snapshot(), nil
}

func (session *ComputerSession) validSessionLocked(id string) bool {
	return !session.closed && session.state.Status == contracts.ComputerControlStatusHuman && session.state.SessionID != nil && id != "" && *session.state.SessionID == id && float64(session.options.Now().UnixMilli()) < session.state.ExpiresAt
}

func (session *ComputerSession) Input(ctx context.Context, raw json.RawMessage) (contracts.RawObject, error) {
	object, err := contracts.DecodeObject(raw, controlResultLimit)
	if err != nil {
		return nil, ErrControlUnconfirmed
	}
	var id string
	if json.Unmarshal(object["sessionId"], &id) != nil {
		return nil, ErrControlExpired
	}
	owner, done, err := session.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	session.mu.Lock()
	if !session.validSessionLocked(id) {
		session.mu.Unlock()
		return nil, ErrControlExpired
	}
	epoch := session.epoch
	session.mu.Unlock()
	result, err := session.guestJSON(owner, "/input", raw)
	if err != nil {
		return nil, err
	}
	expires := float64(session.options.Now().Add(controlInputTTL).UnixMilli())
	var reported float64
	if json.Unmarshal(result["expiresAt"], &reported) == nil && !math.IsNaN(reported) && !math.IsInf(reported, 0) && reported > 0 && reported <= 9007199254740991 {
		expires = reported
	}
	session.mu.Lock()
	if session.epoch == epoch && session.validSessionLocked(id) {
		session.state.ExpiresAt = expires
	}
	session.mu.Unlock()
	session.changed()
	return result, nil
}

func (session *ComputerSession) Release(ctx context.Context, id string) (Control, error) {
	owner, done, err := session.begin(ctx)
	if err != nil {
		return Control{}, err
	}
	defer done()
	session.mu.Lock()
	if !session.validSessionLocked(id) {
		session.mu.Unlock()
		return Control{}, ErrControlExpired
	}

	if session.pending {
		session.mu.Unlock()
		return Control{}, ErrControlBusy
	}
	session.pending = true
	epoch := session.epoch
	session.mu.Unlock()
	defer func() {
		session.mu.Lock()
		session.pending = false
		session.mu.Unlock()
		session.changed()
	}()
	if result, err := session.control(owner, "release", &id); err != nil {
		return Control{}, err
	} else if result.Status != contracts.ComputerControlStatusDant || result.SessionID != nil {
		return Control{}, ErrControlUnconfirmed
	}
	session.mu.Lock()
	if session.closed || session.epoch != epoch {
		session.mu.Unlock()
		return Control{}, ErrControlExpired
	}
	session.state = Control{Status: contracts.ComputerControlStatusDant}
	session.mu.Unlock()
	if err := session.engine.Release(); err != nil {
		return Control{}, err
	}

	return session.Snapshot(), nil
}

func (session *ComputerSession) expirations() {
	defer session.wg.Done()
	for {
		session.mu.Lock()
		var expires float64
		if session.state.SessionID != nil {
			expires = session.state.ExpiresAt
		}
		epoch := session.epoch
		session.mu.Unlock()
		var timer *time.Timer
		var expiry <-chan time.Time
		if expires > 0 {
			delay := time.Duration(expires-float64(session.options.Now().UnixMilli()))*time.Millisecond + controlExpiryGrace
			if delay < time.Millisecond {
				delay = time.Millisecond
			}
			timer = time.NewTimer(delay)
			expiry = timer.C
		}
		select {
		case <-session.ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return
		case <-session.wake:
			if timer != nil {
				timer.Stop()
			}
		case <-expiry:
			session.mu.Lock()
			expired := !session.closed && session.epoch == epoch && session.state.SessionID != nil && float64(session.options.Now().UnixMilli()) >= session.state.ExpiresAt
			if expired {
				session.state = Control{Status: contracts.ComputerControlStatusDant}
				session.epoch++
			}
			session.mu.Unlock()
			if expired {
				_ = session.engine.Release()
				session.changed()
			}
		}
	}
}

func (session *ComputerSession) Close() {
	session.mu.Lock()
	if !session.closed {
		session.closed = true
		session.epoch++
		session.cancel()
	}
	session.mu.Unlock()
	session.wg.Wait()
	session.operations.Wait()
}
