package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type sessionBoundaryEngine struct {
	*controlEngineFixture
	acquireError error
	releaseError error
}

func (engine *sessionBoundaryEngine) Acquire(ctx context.Context) error {
	if engine.acquireError != nil {
		return engine.acquireError
	}
	return engine.controlEngineFixture.Acquire(ctx)
}

func (engine *sessionBoundaryEngine) Release() error {
	if engine.releaseError != nil {
		return engine.releaseError
	}
	return engine.controlEngineFixture.Release()
}

func TestComputerSessionRejectsMalformedGuestProofBeforeLocalTakeover(t *testing.T) {
	for _, raw := range []string{
		`{`, `[]`, `{"status":"human","sessionId":"first","sessionId":"second","expiresAt":1000}`,
		`{"status":"new-status","sessionId":"owner","expiresAt":1000}`,
		`{"status":"taking-over","expiresAt":1000}`,
		`{"status":"taking-over","sessionId":"owner"}`,
		`{"status":"taking-over","sessionId":"","expiresAt":1000}`,
		`{"status":"taking-over","sessionId":null,"expiresAt":1000}`,
		`{"status":"taking-over","sessionId":"owner","expiresAt":-1}`,
		`{"status":"taking-over","sessionId":"owner","expiresAt":9007199254740992}`,
		`{"status":"taking-over","sessionId":"owner","expiresAt":99}`,
		`{"status":"taking-over","sessionId":"` + strings.Repeat("x", 257) + `","expiresAt":1000}`,
		strings.Repeat("x", controlResultLimit+1),
	} {
		t.Run("unconfirmed lease", func(t *testing.T) {
			engine := &controlEngineFixture{}
			var calls atomic.Int32
			guest := guestFixture(func(context.Context, string, json.RawMessage) (*http.Response, error) {
				calls.Add(1)
				return contractResponse(http.StatusOK, raw), nil
			})
			session, err := NewComputerSession(t.Context(), engine, guest, SessionOptions{Now: func() time.Time { return time.UnixMilli(100) }})
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			if _, err := session.Acquire(t.Context()); !errors.Is(err, ErrControlUnconfirmed) || calls.Load() != 1 || session.Pending() || session.Snapshot().SessionID != nil || engine.aborts != 1 || engine.acquired {
				t.Fatal("invalid guest proof was promoted to local human control", err)
			}
		})
	}
}

func TestComputerSessionGuestIOFailureCannotPublishALease(t *testing.T) {
	for _, variant := range []string{"transport", "status", "partial body"} {
		t.Run(variant, func(t *testing.T) {
			engine := &controlEngineFixture{}
			guest := guestFixture(func(context.Context, string, json.RawMessage) (*http.Response, error) {
				switch variant {
				case "transport":
					return nil, io.ErrUnexpectedEOF
				case "status":
					return contractResponse(http.StatusForbidden, `{"private":"body"}`), nil
				default:
					return &http.Response{StatusCode: 200, Body: io.NopCloser(contractFailingReader{})}, nil
				}
			})
			session, _ := NewComputerSession(t.Context(), engine, guest, SessionOptions{})
			defer session.Close()
			if _, err := session.Acquire(t.Context()); !errors.Is(err, ErrControlUnconfirmed) || session.Snapshot().SessionID != nil || engine.acquired {
				t.Fatal("guest I/O failure became a confirmed lease", err)
			}
		})
	}
	for _, test := range []struct {
		ctx    context.Context
		engine ControlEngine
		worker GuestWorker
	}{
		{nil, &controlEngineFixture{}, guestFixture(nil)},
		{t.Context(), nil, guestFixture(nil)},
		{t.Context(), &controlEngineFixture{}, nil},
	} {
		if _, err := NewComputerSession(test.ctx, test.engine, test.worker, SessionOptions{}); !errors.Is(err, ErrControlUnconfirmed) {
			t.Fatal("invalid session dependencies were accepted", err)
		}
	}
}

func TestComputerSessionEngineAndConfirmationFailuresReleaseOnlyTheCapturedLease(t *testing.T) {
	for _, variant := range []string{"engine refuses", "different confirmed owner", "confirmation not human", "expired confirmation"} {
		t.Run(variant, func(t *testing.T) {
			engine := &sessionBoundaryEngine{controlEngineFixture: &controlEngineFixture{}}
			if variant == "engine refuses" {
				engine.acquireError = ErrControlBusy
			}
			releases := 0
			guest := guestFixture(func(_ context.Context, _ string, raw json.RawMessage) (*http.Response, error) {
				var body struct{ Action, SessionID string }
				_ = json.Unmarshal(raw, &body)
				if body.Action == "release" {
					if body.SessionID != "captured-owner" {
						t.Error("recovery targeted another lease")
					}
					releases++
				}
				if body.Action == "confirm" {
					switch variant {
					case "different confirmed owner":
						return controlFixture(body.Action, "replacement", 1000), nil
					case "confirmation not human":
						return controlFixture("acquire", "captured-owner", 1000), nil
					case "expired confirmation":
						return controlFixture(body.Action, "captured-owner", 99), nil
					}
				}
				return controlFixture(body.Action, "captured-owner", 1000), nil
			})
			session, _ := NewComputerSession(t.Context(), engine, guest, SessionOptions{Now: func() time.Time { return time.UnixMilli(100) }})
			defer session.Close()
			if _, err := session.Acquire(t.Context()); err == nil || releases != 1 || session.Snapshot().SessionID != nil || engine.acquired || session.Pending() {
				t.Fatal("failed engine admission or lease confirmation retained takeover", err)
			}
		})
	}
}

func TestComputerSessionInputIsExactAndOnlyRenewsTheCurrentConfirmedLease(t *testing.T) {
	for _, reported := range []string{`{"ok":true}`, `{"expiresAt":-1}`, `{"expiresAt":9007199254740992}`, `{"expiresAt":777}`} {
		engine := &controlEngineFixture{}
		var inputs atomic.Int32
		input := json.RawMessage(`{"sessionId":"captured-owner","action":"type","text":"fixture typed text"}`)
		guest := guestFixture(func(_ context.Context, route string, raw json.RawMessage) (*http.Response, error) {
			if route == "/input" {
				inputs.Add(1)
				if string(raw) != string(input) {
					t.Error("desktop input bytes changed at the guest boundary")
				}
				return contractResponse(http.StatusOK, reported), nil
			}
			var body struct{ Action string }
			_ = json.Unmarshal(raw, &body)
			return controlFixture(body.Action, "captured-owner", 1000), nil
		})
		session, _ := NewComputerSession(t.Context(), engine, guest, SessionOptions{Now: func() time.Time { return time.UnixMilli(100) }})
		if _, err := session.Acquire(t.Context()); err != nil {
			t.Fatal(err)
		}
		for _, invalid := range []string{`{`, `[]`, `{}`, `{"sessionId":12}`, `{"sessionId":"foreign-owner"}`} {
			if _, err := session.Input(t.Context(), json.RawMessage(invalid)); err == nil {
				t.Fatal("invalid or foreign input was forwarded")
			}
		}
		if inputs.Load() != 0 {
			t.Fatal("invalid input reached the guest")
		}
		if _, err := session.Input(t.Context(), input); err != nil || inputs.Load() != 1 {
			t.Fatal("current lease input was rejected or repeated", err)
		}
		wantExpiry := float64(time.UnixMilli(100).Add(controlInputTTL).UnixMilli())
		if reported == `{"expiresAt":777}` {
			wantExpiry = 777
		}
		if snapshot := session.Snapshot(); snapshot.ExpiresAt != wantExpiry {
			t.Fatal("guest expiry or bounded legacy fallback was lost")
		}
		session.Close()
		if _, err := session.Input(t.Context(), input); !errors.Is(err, ErrControlBusy) {
			t.Fatal("closed session accepted new input", err)
		}
		if _, err := session.Release(t.Context(), "captured-owner"); !errors.Is(err, ErrControlBusy) {
			t.Fatal("closed session accepted a release", err)
		}
	}
}

func TestComputerSessionUnknownReleaseRemainsHumanWithoutRepeatingTheGuestAction(t *testing.T) {
	for _, variant := range []string{"transport", "foreign confirmation", "engine refuses"} {
		t.Run(variant, func(t *testing.T) {
			engine := &sessionBoundaryEngine{controlEngineFixture: &controlEngineFixture{}}
			if variant == "engine refuses" {
				engine.releaseError = ErrControlBusy
			}
			releases := 0
			guest := guestFixture(func(_ context.Context, _ string, raw json.RawMessage) (*http.Response, error) {
				var body struct{ Action string }
				_ = json.Unmarshal(raw, &body)
				if body.Action == "release" {
					releases++
					if variant == "transport" {
						return nil, io.ErrUnexpectedEOF
					}
					if variant == "foreign confirmation" {
						return controlFixture("confirm", "another-owner", 1000), nil
					}
				}
				return controlFixture(body.Action, "captured-owner", 1000), nil
			})
			session, _ := NewComputerSession(t.Context(), engine, guest, SessionOptions{Now: func() time.Time { return time.UnixMilli(100) }})
			defer session.Close()
			if _, err := session.Acquire(t.Context()); err != nil {
				t.Fatal(err)
			}
			if _, err := session.Release(t.Context(), "captured-owner"); err == nil || releases != 1 || session.Pending() {
				t.Fatal("unconfirmed release was silently retried or became successful", err)
			}
			if variant != "engine refuses" && session.Snapshot().Status != contracts.ComputerControlStatusHuman {
				t.Fatal("unknown guest outcome was treated as confirmed local release")
			}
		})
	}
}

func TestComputerSessionLeaseExpiryReleasesAdmissionWithoutASecondGuestAction(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		engine := &controlEngineFixture{}
		var guestCalls atomic.Int32
		guest := guestFixture(func(_ context.Context, _ string, raw json.RawMessage) (*http.Response, error) {
			guestCalls.Add(1)
			var body struct{ Action string }
			_ = json.Unmarshal(raw, &body)
			return controlFixture(body.Action, "expiring-owner", float64(time.Now().Add(time.Second).UnixMilli())), nil
		})
		session, _ := NewComputerSession(t.Context(), engine, guest, SessionOptions{})
		defer session.Close()
		if _, err := session.Acquire(t.Context()); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		time.Sleep(time.Second + controlExpiryGrace)
		synctest.Wait()
		if session.Snapshot().SessionID != nil || engine.acquired || engine.releases != 1 || guestCalls.Load() != 2 {
			t.Fatal("lease expiry retained execution admission or repeated guest control")
		}
		if _, err := session.Input(t.Context(), json.RawMessage(`{"sessionId":"expiring-owner"}`)); !errors.Is(err, ErrControlExpired) {
			t.Fatal("expired lease renewed itself through input", err)
		}
	})
}
