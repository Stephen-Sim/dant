package work

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type guardedReferenceWorker struct{ *fakeWorker }

func (worker guardedReferenceWorker) RequestGuarded(ctx context.Context, method string, params contracts.RawObject, guard func() error) (contracts.RawObject, error) {
	if err := guard(); err != nil {
		return nil, err
	}
	return worker.Request(ctx, method, params)
}

func TestReferenceInjectionChecksCapturedOwnerBeforeAndAfterEachTransport(t *testing.T) {
	for _, kind := range []string{"success", "guarded worker", "thread failed", "changed after thread", "changed after injection"} {
		t.Run(kind, func(t *testing.T) {
			engine, persistence, worker := engineFixture(t)
			if kind == "guarded worker" {
				engine.worker = guardedReferenceWorker{worker}
			}
			checks := 0
			current := func() bool {
				checks++
				return !(kind == "changed after thread" && checks >= 3 || kind == "changed after injection" && checks >= 5)
			}
			done := make(chan error, 1)
			go func() {
				_, err := engine.InjectReference(t.Context(), "Quoted current-call reference", current)
				done <- err
			}()
			thread := nextRequest(t, worker, "thread/start")
			failure := errors.New("isolated thread open failure")
			if kind == "thread failed" {
				thread.result <- fakeResponse{err: failure}
			} else {
				thread.result <- fakeResponse{value: contracts.RawObject{"thread": raw(contracts.RawObject{"id": raw("thread-fixture")})}}
				if kind != "changed after thread" {
					injection := nextRequest(t, worker, "thread/inject_items")
					if string(injection.params["threadId"]) != `"thread-fixture"` {
						t.Fatal("reference injection lost its checked thread")
					}
					injection.result <- fakeResponse{value: contracts.RawObject{"accepted": raw(true)}}
				}
			}
			err := awaitWorkAction(t, done)
			switch kind {
			case "thread failed":
				if !errors.Is(err, failure) {
					t.Fatal("failed thread open was treated as successful reference submission", err)
				}
			case "changed after thread", "changed after injection":
				if !errors.Is(err, ErrStaleOwner) {
					t.Fatal("late reference result was adopted by a changed owner", err)
				}
			default:
				if err != nil {
					t.Fatal("owned reference injection failed", err)
				}
			}
			if len(persistence.Snapshot().Messages) != 0 || engine.Snapshot().Active != nil {
				t.Fatal("quoted reference admitted a new task or copied private speech into chat")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestReferenceInjectionRejectsMissingOwnerCancellationAndClosedEngine(t *testing.T) {
	engine, _, worker := engineFixture(t)
	for _, current := range []func() bool{nil, func() bool { return false }} {
		if _, err := engine.InjectReference(t.Context(), "reference", current); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("reference without captured owner reached transport", err)
		}
	}
	engine.referenceGate <- struct{}{}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := engine.InjectReference(ctx, "reference", func() bool { return true }); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled reference gate wait reached transport", err)
	}
	<-engine.referenceGate
	if _, err := engine.requestOwned(t.Context(), "thread/read", nil, func() bool { return false }); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("rejected fallback admission reached the executor", err)
	}
	engine.worker = guardedReferenceWorker{worker}
	if _, err := engine.requestOwned(t.Context(), "thread/read", nil, func() bool { return false }); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("rejected guarded admission reached the executor", err)
	}
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.InjectReference(t.Context(), "reference", func() bool { return true }); !errors.Is(err, ErrClosed) {
		t.Fatal("closed engine acquired a new reference gate", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestReferenceQueueRechecksScopeAfterWaitingAndJoinsOnEngineShutdown(t *testing.T) {
	for _, closeEngine := range []bool{false, true} {
		t.Run(map[bool]string{false: "changed scope", true: "closed engine"}[closeEngine], func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				engine, persistence, worker := engineFixture(t)
				engine.referenceGate <- struct{}{}
				done := make(chan error, 1)
				go func() {
					_, err := engine.InjectReference(t.Context(), "queued reference", func() bool { return true })
					done <- err
				}()
				synctest.Wait()
				if closeEngine {
					if err := engine.Close(); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
						state.ConversationID = "6d61cb2d-2242-4146-972b-1f1d847d5747"
						return nil
					}); err != nil {
						t.Fatal(err)
					}
				}
				<-engine.referenceGate
				want := ErrStaleOwner
				if closeEngine {
					want = ErrClosed
				}
				if err := <-done; !errors.Is(err, want) {
					t.Fatal("queued reference kept authority after its owner ended", err)
				}
				assertWorkerQuiet(t, worker)
			})
		})
	}
}
