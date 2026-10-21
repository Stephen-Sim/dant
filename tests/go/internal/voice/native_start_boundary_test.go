package voice

import (
	"context"
	"errors"
	"strings"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type nativeStartEngineBoundary struct {
	NativeEngine
	thread  func(context.Context) (string, error)
	reserve func(context.Context, string, string) (work.CallStartReservation, error)
	current func(work.CallStartReservation) bool
}

func (engine nativeStartEngineBoundary) Thread(ctx context.Context) (string, error) {
	if engine.thread != nil {
		return engine.thread(ctx)
	}
	return engine.NativeEngine.Thread(ctx)
}

func (engine nativeStartEngineBoundary) ReserveCallStart(ctx context.Context, id, provider string) (work.CallStartReservation, error) {
	if engine.reserve != nil {
		return engine.reserve(ctx, id, provider)
	}
	return engine.NativeEngine.ReserveCallStart(ctx, id, provider)
}

func (engine nativeStartEngineBoundary) CallStartCurrent(reservation work.CallStartReservation) bool {
	if engine.current != nil {
		return engine.current(reservation)
	}
	return engine.NativeEngine.CallStartCurrent(reservation)
}

type nativeStartWorkerBoundary struct {
	work.Worker
	request func(context.Context, string, contracts.RawObject) (contracts.RawObject, error)
}

func (worker nativeStartWorkerBoundary) Request(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
	return worker.request(ctx, method, params)
}

func TestNativeVoiceDiscoveryRejectsInvalidResultsWithoutChangingAllowedVoices(t *testing.T) {
	for _, scenario := range []string{"RPC failure", "missing voices", "empty voices", "too many voices", "oversize voice", "duplicates"} {
		t.Run(scenario, func(t *testing.T) {
			native, worker, _, _ := nativeFixture(t)
			failure := errors.New("isolated voice discovery failure")
			voices := []string{"ember", "ember", "juniper"}
			switch scenario {
			case "empty voices":
				voices = []string{}
			case "too many voices":
				voices = make([]string, 257)
			case "oversize voice":
				voices = []string{strings.Repeat("😀", 41)}
			}
			native.options.Worker = nativeStartWorkerBoundary{Worker: worker, request: func(context.Context, string, contracts.RawObject) (contracts.RawObject, error) {
				if scenario == "RPC failure" {
					return nil, failure
				}
				if scenario == "missing voices" {
					return contracts.RawObject{}, nil
				}
				return contracts.RawObject{"voices": rawValue(contracts.RawObject{"v3": rawValue(voices)})}, nil
			}}
			result, err := native.ListVoices(t.Context())
			if scenario == "duplicates" {
				if err != nil || len(native.voices) != 2 || native.voices[0] != "ember" || native.voices[1] != "juniper" || textField(result, "defaultNative") != DefaultNativeVoice {
					t.Fatal("voice discovery lost stable order or default voice", err)
				}
			} else {
				want := ErrVoiceConnection
				if scenario == "RPC failure" {
					want = failure
				}
				if !errors.Is(err, want) || len(native.voices) != len(NativeVoices()) {
					t.Fatal("invalid voice response changed the allowed voice cache", err)
				}
			}
		})
	}
}

func TestNativeStartupRejectsInvalidAndUnavailableOwnersBeforeSubmission(t *testing.T) {
	for _, scenario := range []string{"invalid SDP", "invalid identity", "disposed", "media busy", "unknown background", "reservation failed", "session changed", "retained session limit", "thread failed", "reservation lost"} {
		t.Run(scenario, func(t *testing.T) {
			native, worker, engine, _ := nativeFixture(t)
			input := NativeStart{SDP: fixtureSDP, CallID: "native-start-boundary", Voice: DefaultNativeVoice}
			want := ErrCallInput
			boundary := nativeStartEngineBoundary{NativeEngine: engine}
			failure := errors.New("isolated native preparation failure")
			switch scenario {
			case "invalid SDP":
				input.SDP = "invalid"
			case "invalid identity":
				input.CallID = "bad\x00call"
			case "disposed":
				native.disposed = true
				want = ErrVoiceClosed
			case "media busy":
				native.session = &nativeSession{}
				want = ErrVoiceBusy
			case "unknown background":
				native.session = &nativeSession{background: true, unknown: true}
				want = ErrNativeUnknown
			case "reservation failed":
				boundary.reserve = func(context.Context, string, string) (work.CallStartReservation, error) {
					return work.CallStartReservation{}, failure
				}
				want = failure
			case "session changed":
				boundary.reserve = func(ctx context.Context, id, provider string) (work.CallStartReservation, error) {
					native.mu.Lock()
					native.session = &nativeSession{background: true}
					native.mu.Unlock()
					return engine.ReserveCallStart(ctx, id, provider)
				}
				want = ErrVoiceBusy
			case "retained session limit":
				for range nativeSessionLimit {
					native.sessions[&nativeSession{}] = true
				}
				want = ErrVoiceBusy
			case "thread failed":
				boundary.thread = func(context.Context) (string, error) { return "", failure }
				want = failure
			case "reservation lost":
				boundary.current = func(work.CallStartReservation) bool { return false }
				want = ErrVoiceCancelled
			}
			native.options.Engine = boundary
			if _, err := native.Start(t.Context(), input); !errors.Is(err, want) {
				t.Fatal("invalid native preparation lost its confirmed-unsent classification", err)
			}
			worker.mu.Lock()
			requests := len(worker.requests)
			worker.mu.Unlock()
			if requests != 0 {
				t.Fatal("rejected native startup contacted the media transport")
			}
			if scenario == "thread failed" || scenario == "reservation lost" {
				if err := native.Close(t.Context()); err != nil {
					t.Fatal("pre-submission failure did not join its session workers", err)
				}
			}
		})
	}
}

func TestNativeStartupWaitsForConfirmedMediaAndRetainsLateUncertainty(t *testing.T) {
	for _, scenario := range []string{"generated identity", "invalid handshake", "missing handshake", "reservation lost after ready"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				native, worker, engine, _ := nativeFixture(t)
				native.options.NewID = func() string { return "generated-native-call" }
				if scenario == "reservation lost after ready" {
					checks := 0
					native.options.Engine = nativeStartEngineBoundary{NativeEngine: engine, current: func(reservation work.CallStartReservation) bool {
						checks++
						return checks == 1 && engine.CallStartCurrent(reservation)
					}}
				}
				if scenario == "invalid handshake" || scenario == "missing handshake" {
					native.options.Worker = nativeStartWorkerBoundary{Worker: worker, request: func(ctx context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
						if method != "thread/realtime/start" {
							return worker.Request(ctx, method, params)
						}
						if scenario == "invalid handshake" {
							_ = native.HandleEvent(ctx, runtime.Event{Method: "thread/realtime/started", Params: contracts.RawObject{"threadId": rawValue("shared-thread"), "version": rawValue("v2")}})
						}
						return contracts.RawObject{}, nil
					}}
				}
				result, err := native.Start(t.Context(), NativeStart{SDP: fixtureSDP, Voice: "unsupported-falls-back"})
				if scenario == "generated identity" {
					if err != nil || result.CallID != "generated-native-call" || native.Snapshot().Voice != DefaultNativeVoice {
						t.Fatal("generated call identity or configured fallback was lost", err)
					}
				} else {
					want := ErrVoiceConnection
					if scenario == "reservation lost after ready" {
						want = ErrNativeUnknown
					}
					if !errors.Is(err, want) || !native.Snapshot().Unknown {
						t.Fatal("unconfirmed media result became a safely retryable call", err)
					}
				}
				_ = native.Close(t.Context())
			})
		})
	}
}

func TestRetiredNativeSessionBudgetKeepsRecentExactIdentities(t *testing.T) {
	var retired nativeRetiredIDs
	retired.add("")
	for index := 0; index < nativeRetiredSessionLimit+2; index++ {
		retired.add(strings.Repeat("x", index+1))
	}
	retired.add(strings.Repeat("x", nativeRetiredSessionLimit+2))
	if retired.has("x") || retired.has("xx") || !retired.has("xxx") || len(retired.order) != nativeRetiredSessionLimit || len(retired.set) != nativeRetiredSessionLimit {
		t.Fatal("retired-session retention lost its bound, ordering or deduplication")
	}
}
