package telegram

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestIncomingPairingAndReceiptFailuresStopBeforeAdmissionOrDelivery(t *testing.T) {
	for _, phase := range []string{"pair-entropy", "pair-baseline", "pair-commit", "receipt"} {
		t.Run(phase, func(t *testing.T) {
			fixture := fixture(t)
			gateway := fixture.Gateway
			originalFile := gateway.file
			update := behaviorUpdate(t, 100, "Authorized fixture request")
			if phase != "receipt" {
				code := strings.Repeat("3", 32)
				gateway.config.Owner = nil
				gateway.config.Pairing = &Pairing{Hash: digest(code), ExpiresAt: fixture.Now.Load() + 10000}
				update.Message.Text = "/start " + code
				if err := gateway.saveLocked(t.Context()); err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.ReadFile(originalFile)
			if err != nil {
				t.Fatal(err)
			}
			failure := errors.New("isolated pairing persistence unavailable")
			gateway.options.Random = func(output []byte) (int, error) {
				if phase == "pair-entropy" {
					return 0, failure
				}
				return copy(output, bytes.Repeat([]byte{0x31}, len(output))), nil
			}
			if phase == "pair-baseline" {
				gateway.options.Store = controlledMirrorPersistence{
					Persistence: fixture.Store,
					mutate: func(context.Context, func(*contracts.State) error) error {
						return failure
					},
				}
			}
			if phase == "pair-commit" || phase == "receipt" {
				gateway.file = fixture.Directory
			}
			err = gateway.Receive(t.Context(), update)
			gateway.file = originalFile
			if err == nil || fixture.Admitted.Load() != 0 || fixture.Sent.Load() != 0 {
				t.Fatal("unconfirmed pairing or receipt crossed the action boundary", err)
			}
			if after, err := os.ReadFile(originalFile); err != nil || !bytes.Equal(after, before) {
				t.Fatal("failed intake changed the last confirmed gateway configuration", err)
			}
		})
	}
}

func TestIncomingProcessingReceiptCannotReplayAndReceiptHistoryRemainsBounded(t *testing.T) {
	fixture := fixture(t)
	gateway := fixture.Gateway
	gateway.config.Receipts = []Receipt{{100, ReceiptProcessing, fixture.Now.Load()}}
	if err := gateway.Receive(t.Context(), behaviorUpdate(t, 100, "Never replay this receipt")); err != nil {
		t.Fatal(err)
	}
	if fixture.Admitted.Load() != 0 || gateway.config.Offset != 101 || gateway.config.Receipts[0].Status != ReceiptProcessing {
		t.Fatal("processing receipt was replayed or falsely completed")
	}
	gateway.config.Receipts = make([]Receipt, maxReceipts)
	for index := range gateway.config.Receipts {
		gateway.config.Receipts[index] = Receipt{int64(index), ReceiptDone, fixture.Now.Load()}
	}
	id := int64(maxReceipts + 100)
	if err := gateway.Receive(t.Context(), behaviorUpdate(t, id, "New authorized fixture request")); err != nil {
		t.Fatal(err)
	}
	if fixture.Admitted.Load() != 1 || len(gateway.config.Receipts) != maxReceipts || gateway.config.Receipts[0].ID != 1 || gateway.config.Receipts[maxReceipts-1].ID != id {
		t.Fatal("receipt history discarded current identity or grew without a bound")
	}
}

func TestIncomingDownloadFailuresCannotAdmitOrPublishAFile(t *testing.T) {
	for _, phase := range []string{"lookup", "malformed-result", "missing-response"} {
		t.Run(phase, func(t *testing.T) {
			fixture := fixture(t)
			update := behaviorUpdate(t, 100, "")
			update.Message.Document = &File{ID: "fixture-document"}
			fixture.Send = func(request *http.Request) (*http.Response, error) {
				if strings.HasSuffix(request.URL.Path, "/getFile") {
					if phase == "lookup" {
						return nil, errors.New("isolated lookup unavailable")
					}
					if phase == "malformed-result" {
						return reply(200, `{"ok":true,"result":[]}`), nil
					}
					return reply(200, `{"ok":true,"result":{"file_path":"documents/fixture.bin"}}`), nil
				}
				return nil, nil
			}
			if err := fixture.Gateway.Receive(t.Context(), update); err != nil {
				t.Fatal("failed download lost its intake receipt", err)
			}
			state := fixture.Store.Snapshot()
			if fixture.Admitted.Load() != 0 || len(state.Messages) != 1 || len(state.Messages[0].Attachments) != 0 || state.Messages[0].Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) || fixture.Gateway.config.Receipts[0].Status != ReceiptFailed {
				t.Fatal("failed download published an attachment or admitted execution")
			}
		})
	}
}

func TestTelegramConfigurationAndTransportBoundariesRemainTypedAndFixed(t *testing.T) {
	fixture := fixture(t)
	mode, combine := ForwardAll, false
	if _, err := fixture.Gateway.Configure(t.Context(), ConfigureInput{ForwardMode: &mode, CombineReplies: &combine}); err != nil {
		t.Fatal(err)
	}
	if fixture.Gateway.config.ForwardMode != ForwardAll || fixture.Gateway.config.CombineReplies {
		t.Fatal("typed forwarding preferences were not retained")
	}
	if _, err := ReadConfigure(contracts.RawObject{"forwardMode": raw(false)}); !errors.Is(err, ErrConfig) {
		t.Fatal("a non-text forwarding policy was accepted", err)
	}
	fixture.Gateway.config.Token = nil
	enabled := true
	if _, err := fixture.Gateway.Configure(t.Context(), ConfigureInput{Enabled: &enabled}); !errors.Is(err, ErrConfig) {
		t.Fatal("enabled gateway accepted a missing token", err)
	}
	if _, err := fixture.Gateway.api(t.Context(), fixtureToken, "not-a-protocol-method", nil, ""); !errors.Is(err, ErrConfig) {
		t.Fatal("unregistered Telegram operation reached transport", err)
	}
	if reason := failureReason(t.Context(), &net.DNSError{IsTimeout: true}); reason != "dns" {
		t.Fatal("DNS failure lost its fixed operational classification")
	}
	if reason := failureReason(t.Context(), &net.OpError{Op: "read", Err: timeoutNetworkError{}}); reason != "timeout" {
		t.Fatal("network timeout lost its fixed operational classification")
	}
}

type timeoutNetworkError struct{}

func (timeoutNetworkError) Error() string   { return "isolated timeout" }
func (timeoutNetworkError) Timeout() bool   { return true }
func (timeoutNetworkError) Temporary() bool { return false }
