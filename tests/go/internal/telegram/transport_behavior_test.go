package telegram

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type failingBody struct{}

type timeoutFailure struct{}

func (timeoutFailure) Error() string   { return "isolated timeout" }
func (timeoutFailure) Timeout() bool   { return true }
func (timeoutFailure) Temporary() bool { return true }

func (failingBody) Read([]byte) (int, error) { return 0, errors.New("private body read detail") }
func (failingBody) Close() error             { return nil }

func TestBotAPIFailuresExposeOnlyStableClassificationAndNeverMakeUnknownWritesReplayable(t *testing.T) {
	for _, scenario := range []string{"dns", "tls", "authority", "timeout", "cancelled", "body-read", "nil-response", "nil-body", "stream-large", "known-rejected", "bad-code", "api-server"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			ctx := t.Context()
			want, unknown := "network", true
			fixture.Gateway.options.HTTP = httpFunc(func(*http.Request) (*http.Response, error) {
				switch scenario {
				case "dns":
					return nil, &net.DNSError{Err: "private resolver detail"}
				case "tls":
					return nil, &tls.CertificateVerificationError{Err: errors.New("private certificate detail")}
				case "authority":
					return nil, x509.UnknownAuthorityError{}
				case "timeout":
					return nil, timeoutFailure{}
				case "cancelled":
					return nil, context.Canceled
				case "body-read":
					return &http.Response{StatusCode: 200, Body: failingBody{}}, nil
				case "nil-response":
					return nil, nil
				case "nil-body":
					return &http.Response{StatusCode: 200}, nil
				case "stream-large":
					return reply(200, strings.Repeat("x", MaxResponseBytes+1)), nil
				case "known-rejected":
					return reply(403, `{"ok":false,"error_code":403,"description":"private rejection detail"}`), nil
				case "bad-code":
					return reply(400, `{"ok":false,"error_code":null}`), nil
				default:
					return reply(200, `{"ok":false,"error_code":503}`), nil
				}
			})
			switch scenario {
			case "dns":
				want = "dns"
			case "tls", "authority":
				want = "tls"
			case "timeout":
				want = "timeout"
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
				want = "cancelled"
			case "nil-response", "nil-body", "bad-code":
				want = "invalid-response"
			case "stream-large":
				want = "response-too-large"
			case "known-rejected":
				want, unknown = "rejected", false
			case "api-server":
				want = "server"
			}
			_, err := fixture.Gateway.api(ctx, fixtureToken, "sendMessage", []byte(`{}`), "")
			var failure *OperationError
			if !errors.As(err, &failure) || failure.Reason != want || failure.UnconfirmedOutcome() != unknown || failure.Error() != "telegram_request_failed" {
				t.Fatal("Bot API failure lost bounded classification or send uncertainty", err)
			}
		})
	}
}

func TestPollingConnectionRecoversFromReadFailureThenClearsOnlyItsOwnError(t *testing.T) {
	fixture := fixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	fixture.Gateway.options.RetryBase = time.Millisecond
	var mu sync.Mutex
	polls, observations := 0, []bool{}
	fixture.Gateway.options.Changed = func() {
		fixture.Gateway.mu.Lock()
		connected := fixture.Gateway.connected
		pollError := fixture.Gateway.config.PollError
		lastError := fixture.Gateway.config.LastError
		fixture.Gateway.mu.Unlock()
		mu.Lock()
		observations = append(observations, connected)
		mu.Unlock()
		if connected {
			if pollError != nil || lastError != nil {
				t.Error("confirmed polling recovery retained its obsolete connection error")
			}
			cancel()
		}
	}
	fixture.Send = func(request *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(request.URL.Path, "/getUpdates") {
			t.Error("poll loop used an unrelated write")
		}
		polls++
		if polls == 1 {
			return reply(500, `{"ok":false,"error_code":500}`), nil
		}
		return reply(200, `{"ok":true,"result":[{"update_id":100}]}`), nil
	}
	fixture.Gateway.pollLoop(ctx)
	mu.Lock()
	defer mu.Unlock()
	if polls != 2 || len(observations) < 2 || observations[0] || !observations[len(observations)-1] {
		t.Fatal("poll loop did not recover from a safe read failure")
	}
}

func TestPollingExplicitAuthenticationFailureStopsWithoutRetryOrTaskAdmission(t *testing.T) {
	for _, status := range []int{401, 403, 409} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			fixture := fixture(t)
			fixture.Send = func(*http.Request) (*http.Response, error) {
				return reply(status, string(raw(map[string]any{"ok": false, "error_code": status}))), nil
			}
			fixture.Gateway.pollLoop(t.Context())
			if fixture.Sent.Load() != 1 || fixture.Admitted.Load() != 0 || string(fixture.Gateway.Status()["connected"]) != "false" || string(fixture.Gateway.Status()["connectionError"]) == "null" {
				t.Fatal("terminal polling rejection retried or hid its connection problem")
			}
		})
	}
}

func TestGatewayCloseRejectsNewOperationsAndCancelledWaitDoesNotAcquireSerializedOwnership(t *testing.T) {
	fixture := fixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	fixture.Gateway.admin <- struct{}{}
	if err := acquire(ctx, fixture.Gateway.admin); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled waiter acquired an occupied administrative gate")
	}
	<-fixture.Gateway.admin
	if err := fixture.Gateway.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := fixture.Gateway.Scan(t.Context()); !errors.Is(err, ErrClosed) {
		t.Fatal("closed gateway accepted another scan")
	}
	if _, err := fixture.Gateway.Configure(t.Context(), ConfigureInput{}); !errors.Is(err, ErrClosed) {
		t.Fatal("closed gateway accepted policy mutation")
	}
	fixture.Gateway.Start()
	if _, err := fixture.Gateway.Flush(t.Context()); !errors.Is(err, ErrClosed) {
		t.Fatal("closed gateway accepted outbound work")
	}
}

func TestBotAPIRejectsMethodsOutsideItsFixedCapabilitySetBeforeAnyHTTP(t *testing.T) {
	fixture := fixture(t)
	for _, input := range []struct{ token, method string }{{fixtureToken, "deleteWebhook"}, {"invalid", "getUpdates"}} {
		if _, err := fixture.Gateway.api(t.Context(), input.token, input.method, []byte(`{}`), ""); !errors.Is(err, ErrConfig) || fixture.Sent.Load() != 0 {
			t.Fatal("invalid transport capability reached HTTP")
		}
	}
	response := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("isolated")), ContentLength: 8}
	if _, err := responseBytes(response, 7); err == nil {
		t.Fatal("declared body length bypassed the reader budget")
	}
}

func TestOnlyExplicitRateLimitRejectionPermitsABoundedDeliveryRetry(t *testing.T) {
	for _, scenario := range []string{"rate-limit", "rejected", "ambiguous-rate-limit"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			fixture.add(t, contracts.RoleAssistant, "isolated rate-limited reply")
			fixture.Send = func(*http.Request) (*http.Response, error) {
				if scenario == "rejected" {
					return reply(400, `{"ok":false,"error_code":400}`), nil
				}
				if scenario == "ambiguous-rate-limit" {
					return reply(429, `{"ok":null,"error_code":429,"parameters":{"retry_after":0.001}}`), nil
				}
				return reply(429, `{"ok":false,"error_code":429,"parameters":{"retry_after":0.001}}`), nil
			}
			fixture.flush(t)
			fixture.Now.Add(2)
			fixture.flush(t)
			fixture.flush(t)
			attempts, status := int32(1), OutboxFailed
			if scenario == "rate-limit" {
				attempts = 3
			} else if scenario == "ambiguous-rate-limit" {
				status = OutboxUnknown
			}
			if fixture.Sent.Load() != attempts || len(fixture.Gateway.config.Outbox) != 1 || fixture.Gateway.config.Outbox[0].Status != status || fixture.Gateway.config.Outbox[0].Attempts != int(attempts) {
				t.Fatal("delivery retried without confirmed rejection or exceeded its bounded retry allowance")
			}
		})
	}
}
