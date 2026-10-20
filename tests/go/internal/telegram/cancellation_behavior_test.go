package telegram

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

type cancelledGatewayOperation struct {
	name  string
	admin bool
	run   func(context.Context, *Gateway) error
}

func cancellationConfigure(ctx context.Context, gateway *Gateway) error {
	enabled := false
	_, err := gateway.Configure(ctx, ConfigureInput{Enabled: &enabled})
	return err
}

func cancellationDisconnect(ctx context.Context, gateway *Gateway) error {
	_, err := gateway.Disconnect(ctx, true)
	return err
}

func cancellationClose(ctx context.Context, gateway *Gateway) error {
	return gateway.Close(ctx)
}

func cancellationScan(ctx context.Context, gateway *Gateway) error {
	return gateway.Scan(ctx)
}

func cancellationConfigBytes(t *testing.T, fixture *gatewayFixture) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixture.Directory, "telegram.json"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestCancelledSerializedGatewayRequestsKeepTheCurrentOwnerAndDoNotAcquireAnotherOperationsGate(t *testing.T) {
	for _, operation := range []cancelledGatewayOperation{
		{"configure admin", true, cancellationConfigure},
		{"pair admin", true, func(ctx context.Context, gateway *Gateway) error {
			_, err := gateway.Pair(ctx)
			return err
		}},
		{"disconnect admin", true, cancellationDisconnect},
		{"close admin", true, cancellationClose},
		{"scan operation", false, cancellationScan},
		{"configure operation", false, cancellationConfigure},
		{"disconnect operation", false, cancellationDisconnect},
		{"close operation", false, cancellationClose},
	} {
		t.Run(operation.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := fixture(t)
				gateway := fixture.Gateway
				before := cancellationConfigBytes(t, fixture)
				gate := gateway.operations
				if operation.admin {
					gate = gateway.admin
				}
				gate <- struct{}{}
				held := true
				defer func() {
					if held {
						select {
						case <-gate:
						default:
						}
					}
				}()
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				done := make(chan error, 1)
				go func() { done <- operation.run(ctx, gateway) }()

				// The public request must already be waiting behind another owner;
				// cancellation cannot randomly win an otherwise available gate.
				synctest.Wait()
				cancel()
				if err := <-done; !errors.Is(err, context.Canceled) {
					t.Fatal("a cancelled serialized request was not rejected", err)
				}
				if len(gate) != 1 {
					t.Fatal("a cancelled request consumed or released another operation's ownership")
				}
				if !bytes.Equal(before, cancellationConfigBytes(t, fixture)) || fixture.Admitted.Load() != 0 || fixture.Sent.Load() != 0 {
					t.Fatal("cancelled administration changed pairing or performed external work")
				}
				<-gate
				held = false
				if err := gateway.Close(t.Context()); err != nil {
					t.Fatal("cancelled ownership left the gateway impossible to join", err)
				}
			})
		})
	}
}

func TestCancelledPollingCannotAdmitOrAcknowledgeAnUpdateReturnedAfterCancellation(t *testing.T) {
	fixture := fixture(t)
	before := cancellationConfigBytes(t, fixture)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	fixture.Send = func(request *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(request.URL.Path, "/getUpdates") {
			t.Error("cancelled polling attempted an unrelated API operation")
		}
		cancel()
		return reply(http.StatusOK, `{"ok":true,"result":[{"update_id":77}]}`), nil
	}
	if err := fixture.Gateway.PollOnce(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("a late update crossed the cancelled polling owner", err)
	}
	if !bytes.Equal(before, cancellationConfigBytes(t, fixture)) || fixture.Admitted.Load() != 0 || fixture.Sent.Load() != 1 || len(fixture.Store.Snapshot().Messages) != 0 {
		t.Fatal("cancelled polling advanced a durable offset, admitted work or sent another API request")
	}
	if err := fixture.Gateway.Scan(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("an already-cancelled mirror request crossed admission", err)
	}
}

func TestPollingWithoutAnEnabledVerifiedBotNeverContactsTheTransport(t *testing.T) {
	for _, scenario := range []string{"disabled", "no token", "no bot"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			gateway := fixture.Gateway
			gateway.mu.Lock()
			switch scenario {
			case "disabled":
				gateway.config.Enabled = false
			case "no token":
				gateway.config.Token = nil
			case "no bot":
				gateway.config.Bot = nil
			}
			gateway.mu.Unlock()
			before := cancellationConfigBytes(t, fixture)
			if err := gateway.PollOnce(t.Context()); err != nil {
				t.Fatal("passive incomplete polling returned an unrelated transport error", err)
			}
			if fixture.Sent.Load() != 0 || fixture.Admitted.Load() != 0 || !bytes.Equal(before, cancellationConfigBytes(t, fixture)) {
				t.Fatal("incomplete polling contacted Telegram or altered durable configuration")
			}
		})
	}
}

func TestUnjoinedPollingConsumerNeverReportsSuccessfulReconfigurationDisconnectionOrClose(t *testing.T) {
	for _, operation := range []cancelledGatewayOperation{
		{name: "configure", run: cancellationConfigure},
		{name: "disconnect", run: cancellationDisconnect},
		{name: "close", run: cancellationClose},
	} {
		t.Run(operation.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := fixture(t)
				gateway := fixture.Gateway
				gateway.options.AutoPoll = true
				entered := make(chan context.Context, 1)
				release := make(chan struct{})
				defer close(release)
				fixture.Send = func(request *http.Request) (*http.Response, error) {
					if !strings.HasSuffix(request.URL.Path, "/getUpdates") {
						t.Error("owned polling attempted a write")
					}
					entered <- request.Context()
					<-release
					return nil, request.Context().Err()
				}
				before := cancellationConfigBytes(t, fixture)
				gateway.Start()
				var poll context.Context
				select {
				case poll = <-entered:
				case <-time.After(5 * time.Second):
					t.Fatal("isolated polling consumer did not start")
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				done := make(chan error, 1)
				go func() { done <- operation.run(ctx, gateway) }()
				select {
				case <-poll.Done():
				case <-time.After(5 * time.Second):
					t.Fatal("administration did not cancel its polling consumer")
				}

				// Cancellation was delivered, but the injected consumer has not yet
				// joined. No successful acknowledgement or configuration commit is safe.
				// Close cancels the gateway before acquiring its admin gate. Wait for
				// administration to reach the join, rather than racing that acquisition.
				synctest.Wait()
				cancel()
				if err := <-done; !errors.Is(err, ErrClosed) {
					t.Fatal("unconfirmed polling shutdown claimed administrative success", err)
				}
				if !bytes.Equal(before, cancellationConfigBytes(t, fixture)) || fixture.Admitted.Load() != 0 || fixture.Sent.Load() != 1 || string(gateway.Status()["connected"]) != "false" {
					t.Fatal("unjoined polling changed owner, admitted work or claimed a live connection")
				}
			})
		})
	}
}
