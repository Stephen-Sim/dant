package voice

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

type rejectedServiceReservation struct{ serviceReservation }

func (*rejectedServiceReservation) ReserveCallStart(context.Context, string, string) (work.CallStartReservation, error) {
	return work.CallStartReservation{}, ErrVoiceBusy
}

func TestServiceStartFailuresReleaseReservationsAndNeverCreateMedia(t *testing.T) {
	for _, kind := range []string{"starting", "invalid call", "no reservation", "reservation rejected", "memory failed", "no API", "no native", "duplicate receipt", "invalid API offer"} {
		t.Run(kind, func(t *testing.T) {
			api, socket, hangups := apiFixture(t, APIOptions{})
			reservation := &serviceReservation{reserved: make(chan struct{})}
			cancelled := 0
			service := NewService(ServiceOptions{
				API: api, Reservations: reservation,
				Settings:    func() contracts.Settings { return contracts.Settings{APIVoice: "marin"} },
				CancelOwner: func(context.Context, string) error { cancelled++; return nil },
			})
			input := CallStartRequest{CallID: "call", SDP: fixtureSDP, Provider: "api"}
			switch kind {
			case "starting":
				service.starting = true
			case "invalid call":
				input.CallID = "invalid\ncall"
			case "no reservation":
				service.options.Reservations = nil
			case "reservation rejected":
				service.options.Reservations = &rejectedServiceReservation{}
			case "memory failed":
				service.options.Memory = func(context.Context) (string, error) { return "", errors.New("isolated memory failure") }
			case "no API":
				service.options.API = nil
			case "no native":
				input.Provider = "subscription"
			case "duplicate receipt":
				service.receipts[input.CallID] = &callReceipt{}
			case "invalid API offer":
				input.SDP = "invalid offer"
			}
			if _, err := service.StartCall(t.Context(), input); err == nil || socket.count("conversation.item.create") != 0 || hangups.Load() != 0 || service.Snapshot() != nil {
				t.Fatal("invalid start created or published a media session", kind, err)
			}
			if kind == "invalid API offer" && cancelled != 1 {
				t.Fatal("failed admitted call did not retire its exact reservation owner")
			}
			if kind == "memory failed" || kind == "no API" || kind == "duplicate receipt" || kind == "invalid API offer" {
				reservation.mu.Lock()
				released := reservation.released
				reservation.mu.Unlock()
				if !released {
					t.Fatal("failed start leaked its execution reservation")
				}
			}
		})
	}
}

func TestServiceRechecksReservationAfterMediaCreationAndConfirmsItsHangup(t *testing.T) {
	for _, hangupFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed hangup", true: "unconfirmed hangup"}[hangupFails], func(t *testing.T) {
			api, _, hangups := apiFixture(t, APIOptions{})
			reservation := &serviceReservation{reserved: make(chan struct{})}
			dial := api.options.Dial
			api.options.Dial = func(ctx context.Context, address, key string) (VoiceSocket, error) {
				reservation.mu.Lock()
				reservation.current = false
				reservation.mu.Unlock()
				return dial(ctx, address, key)
			}
			if hangupFails {
				client := api.options.HTTP
				api.options.HTTP = voiceHTTPFunc(func(request *http.Request) (*http.Response, error) {
					if strings.HasSuffix(request.URL.Path, "/hangup") {
						return nil, errors.New("isolated hangup failure")
					}
					return client.Do(request)
				})
			}
			service := NewService(ServiceOptions{API: api, Reservations: reservation})
			_, err := service.StartCall(t.Context(), CallStartRequest{CallID: "call", SDP: fixtureSDP, Provider: "api"})
			if hangupFails {
				if !errors.Is(err, ErrVoiceHangup) {
					t.Fatal("unknown remote hangup was reported confirmed", err)
				}
			} else if !errors.Is(err, ErrVoiceCancelled) || hangups.Load() != 1 || service.Snapshot() != nil {
				t.Fatal("changed reservation kept the newly created call active", err)
			}
		})
	}
}

func TestServiceAPIMessagesRequireTranscriptAndDurableReferenceBeforeDelivery(t *testing.T) {
	for _, kind := range []string{"transcript unavailable", "reference unavailable", "reference rejected", "success"} {
		t.Run(kind, func(t *testing.T) {
			api, socket, _ := apiFixture(t, APIOptions{})
			socket.respond = func(event contracts.RawObject) {
				if textField(event, "type") == "conversation.item.create" {
					socket.emit(object(map[string]any{"type": "conversation.item.added", "item": objectField(event, "item")}))
				}
			}
			startAPIFixture(t, api)
			service := NewService(ServiceOptions{API: api})
			if kind == "transcript unavailable" {
				api.mu.Lock()
				api.session.conversationError = true
				api.mu.Unlock()
			}
			remembered := 0
			if kind != "reference unavailable" {
				service.options.RememberCallInput = func(_ context.Context, message *contracts.ChatMessage, callID string) error {
					remembered++
					if callID != "fixture-call" || message.ID != "typed" {
						t.Fatal("durable call reference lost exact input ownership")
					}
					if kind == "reference rejected" {
						return ErrVoiceContext
					}
					return nil
				}
			}
			result, err := service.Message(t.Context(), MessageOptions{CallID: "fixture-call", Message: &contracts.ChatMessage{ID: "typed", Role: contracts.RoleUser, Text: "Current request"}})
			if kind == "success" {
				if err != nil || result.Submission != contracts.SubmissionStatusConfirmed || remembered != 1 || socket.count("conversation.item.create") != 1 {
					t.Fatal("confirmed durable typed input did not reach the active call once", err)
				}
			} else if err == nil || socket.count("conversation.item.create") != 0 {
				t.Fatal("unconfirmed transcript or reference reached call delivery", kind, err)
			}
			if service.APIState().Call == nil {
				t.Fatal("API service state omitted its active call")
			}
			if err := service.Close(t.Context()); err != nil {
				t.Fatal("service failed to close its API lifetime", err)
			}
		})
	}
}
