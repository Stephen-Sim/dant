package telegram

import (
	"context"
	"net/http"
	"testing"
	"testing/synctest"
	"time"
)

func TestPollingRateLimitWaitIsReadOnlyBoundedAndCancellable(t *testing.T) {
	for _, mode := range []string{"retry", "cancelled-wait", "failed-receipt"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := fixture(t)
				gateway := fixture.Gateway
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				if mode == "cancelled-wait" {
					var timeoutCancel context.CancelFunc
					ctx, timeoutCancel = context.WithTimeout(ctx, time.Second)
					defer timeoutCancel()
				}
				originalFile := gateway.file
				defer func() { gateway.file = originalFile }()
				attempts := 0
				fixture.Send = func(request *http.Request) (*http.Response, error) {
					attempts++
					if mode == "failed-receipt" {
						gateway.file = fixture.Directory
					}
					if attempts == 1 {
						return reply(429, `{"ok":false,"error_code":429,"parameters":{"retry_after":2}}`), nil
					}
					return reply(401, `{"ok":false,"error_code":401}`), nil
				}

				started := time.Now()
				gateway.pollLoop(ctx)
				if mode == "retry" {
					if attempts != 2 || time.Since(started) != 2*time.Second {
						t.Fatal("polling did not honor the confirmed bounded read retry")
					}
				} else if attempts != 1 {
					t.Fatal("cancelled or unpersisted polling repeated its request")
				}
				if fixture.Admitted.Load() != 0 || gateway.connected || gateway.config.Owner.PairingID != "fixture-pairing" {
					t.Fatal("failed polling admitted work, claimed connectivity, or changed its owner")
				}
			})
		})
	}
}

func TestOutboundPumpConsumesWakeAndTimerAndJoinsOnCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fixture := fixture(t)
		gateway := fixture.Gateway
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		observations := 0
		gateway.options.Now = func() time.Time {
			observations++
			return time.UnixMilli(fixture.Now.Load())
		}
		done := make(chan struct{})
		go func() {
			defer close(done)
			gateway.outboundLoop(ctx)
		}()
		synctest.Wait()
		before := observations
		gateway.Wake()
		synctest.Wait()
		if observations <= before {
			t.Fatal("outbound wake did not recheck persisted intent")
		}
		before = observations
		time.Sleep(30 * time.Second)
		synctest.Wait()
		if observations <= before {
			t.Fatal("outbound timer did not recheck persisted intent")
		}
		cancel()
		<-done
		if fixture.Sent.Load() != 0 || fixture.Admitted.Load() != 0 {
			t.Fatal("idle outbound lifetime performed an external action")
		}
	})
}
