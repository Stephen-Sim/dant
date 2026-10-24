package telegram

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestStartedPollingTerminalFailureStopsBothConsumersWithoutRestart(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		language string
		status   int
	}{
		{name: "successful-poll-save-failure", language: "en"},
		{name: "successful-poll-save-failure-chinese", language: "zh"},
		{name: "unauthorized", status: http.StatusUnauthorized},
		{name: "forbidden", status: http.StatusForbidden},
		{name: "polling-conflict", status: http.StatusConflict},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := fixture(t)
				gateway := fixture.Gateway
				gateway.options.AutoPoll = true
				if scenario.language == "zh" {
					if err := fixture.Store.Mutate(t.Context(), func(state *contracts.State) error {
						state.Settings.Language = "zh"
						return nil
					}); err != nil {
						t.Fatal(err)
					}
				}
				originalFile := gateway.file
				defer func() {
					if err := gateway.stopLoops(t.Context()); err != nil {
						t.Error("isolated consumers could not be joined", err)
					}
					gateway.mu.Lock()
					gateway.file = originalFile
					gateway.mu.Unlock()
				}()
				fixture.Send = func(request *http.Request) (*http.Response, error) {
					if !strings.HasSuffix(request.URL.Path, "/getUpdates") {
						t.Error("terminal intake failure attempted outbound work")
					}
					if scenario.status != 0 {
						return reply(scenario.status, string(raw(map[string]any{"ok": false, "error_code": scenario.status}))), nil
					}
					gateway.mu.Lock()
					gateway.file = fixture.Directory
					gateway.mu.Unlock()
					return reply(http.StatusOK, `{"ok":true,"result":[]}`), nil
				}

				gateway.Start()
				time.Sleep(time.Second)
				synctest.Wait()
				gateway.mu.Lock()
				done := gateway.loopDone
				connected := gateway.connected
				pollError := gateway.config.PollError
				lastError := gateway.config.LastError
				offset := gateway.config.Offset
				owner := *gateway.config.Owner
				gateway.mu.Unlock()
				if done == nil {
					t.Fatal("started consumers lost their join owner")
				}
				select {
				case <-done:
				default:
					t.Error("terminal polling left its outbound sibling running")
				}
				if connected || pollError == nil || lastError == nil || *pollError != *lastError {
					t.Error("terminated polling claimed connectivity or lost its classified error")
				}
				if scenario.status == 0 && (pollError == nil || *pollError != gateway.word("pollPersistenceFailed")) {
					t.Error("polling persistence failure lost its localized fixed classification")
				}
				if offset != 0 || owner.PairingID != "fixture-pairing" || fixture.Admitted.Load() != 0 || fixture.Sent.Load() != 1 {
					t.Error("terminal intake failure reset its owner, repeated a request, or admitted work")
				}
				gateway.Start()
				synctest.Wait()
				if fixture.Sent.Load() != 1 {
					t.Error("terminal consumer restarted without explicit administrative recovery")
				}
			})
		})
	}
}

func TestStartedPollingFailureCancelsUnjoinedOutboundAndPreservesUnknownDelivery(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := fixture(t)
		gateway := fixture.Gateway
		gateway.options.AutoPoll = true
		connected := make(chan struct{}, 1)
		pollEntered := make(chan struct{})
		failPoll := make(chan struct{})
		outboundEntered := make(chan context.Context, 1)
		releaseOutbound := make(chan struct{})
		defer close(releaseOutbound)
		gateway.options.Changed = func() {
			gateway.mu.Lock()
			online := gateway.connected
			gateway.mu.Unlock()
			if online {
				select {
				case connected <- struct{}{}:
				default:
				}
			}
		}
		polls := 0
		fixture.Send = func(request *http.Request) (*http.Response, error) {
			if strings.HasSuffix(request.URL.Path, "/getUpdates") {
				polls++
				if polls == 1 {
					return reply(http.StatusOK, `{"ok":true,"result":[]}`), nil
				}
				if polls > 2 {
					t.Error("terminal intake failure repeated polling")
					return nil, context.Canceled
				}
				close(pollEntered)
				<-failPoll
				return reply(http.StatusUnauthorized, `{"ok":false,"error_code":401}`), nil
			}
			if !strings.HasSuffix(request.URL.Path, "/sendMessage") {
				t.Error("isolated consumer used an unrelated capability")
			}
			outboundEntered <- request.Context()
			<-releaseOutbound
			return nil, request.Context().Err()
		}
		gateway.Start()
		<-connected
		<-pollEntered
		gateway.mu.Lock()
		_, err := gateway.queueTextLocked(t.Context(), "command:isolated", "isolated outbound receipt", OutboxItem{})
		gateway.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		gateway.Wake()
		outbound := <-outboundEntered
		close(failPoll)
		synctest.Wait()
		select {
		case <-outbound.Done():
		default:
			t.Error("terminal polling did not cancel its outbound sibling")
		}
		gateway.mu.Lock()
		done := gateway.loopDone
		online := gateway.connected
		gateway.mu.Unlock()
		if online {
			t.Error("unjoined outbound work kept terminated intake online")
		}
		select {
		case <-done:
			t.Fatal("consumer owner acknowledged shutdown before its outbound request joined")
		default:
		}
		ctx, cancel := context.WithTimeout(t.Context(), time.Millisecond)
		defer cancel()
		if err := gateway.stopLoops(ctx); !errors.Is(err, ErrClosed) {
			t.Error("unjoined outbound request claimed successful administrative shutdown", err)
		}
		releaseOutbound <- struct{}{}
		<-done
		gateway.mu.Lock()
		item := *gateway.config.Outbox[0]
		gateway.mu.Unlock()
		if item.Status != OutboxUnknown || item.Attempts != 1 || polls != 2 || fixture.Sent.Load() != 3 || fixture.Admitted.Load() != 0 {
			t.Error("cancelled outbound delivery was replayed or lost its unknown outcome")
		}
	})
}
