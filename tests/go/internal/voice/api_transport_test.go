package voice

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

func TestVoiceRemoteCallLocationAllowsOnlyItsFixedAuthenticatedOrigin(t *testing.T) {
	for _, test := range []struct{ location, id string }{
		{voiceAPI + "/rtc_known", "rtc_known"}, {"/v1/realtime/calls/rtc_known/", "rtc_known"},
		{"http://api.openai.com/v1/realtime/calls/rtc_known", ""}, {"https://other.invalid/v1/realtime/calls/rtc_known", ""}, {"https://user@api.openai.com/v1/realtime/calls/rtc_known", ""}, {"/v1/realtime/calls/rtc_known?token=unsafe", ""}, {"/v1/realtime/calls/not-a-call", ""}, {"%zz", ""},
	} {
		if got := remoteID(&http.Response{Header: http.Header{"Location": []string{test.location}}}); got != test.id {
			t.Fatal("untrusted remote call location was accepted or valid identity was lost")
		}
	}
	if err := defaultVoiceHTTP().CheckRedirect(nil, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatal("voice credentials could follow a redirect")
	}
	for _, status := range []int{401, 403, 404, 429, 500} {
		if voiceHTTPError(status) == nil {
			t.Fatal("provider error status was not classified")
		}
	}
}

func TestVoiceSocketUsesTextFramesAndClosesItsIsolatedConnection(t *testing.T) {
	for _, binary := range []bool{false, true} {
		t.Run(map[bool]string{false: "text", true: "binary rejected"}[binary], func(t *testing.T) {
			done := make(chan error, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				connection, err := websocket.Accept(w, r, nil)
				if err != nil {
					done <- err
					return
				}
				defer connection.CloseNow()
				kind, data, err := connection.Read(r.Context())
				if err != nil || kind != websocket.MessageText || string(data) != "fixture text" {
					done <- errors.New("isolated text write was not received")
					return
				}
				kind = websocket.MessageText
				if binary {
					kind = websocket.MessageBinary
				}
				done <- connection.Write(r.Context(), kind, []byte("fixture reply"))
			}))
			defer server.Close()
			socket, err := dialVoice(t.Context(), "ws"+strings.TrimPrefix(server.URL, "http"), fixtureVoiceKey)
			if err != nil {
				t.Fatal(err)
			}
			defer socket.Close()
			if err := socket.Write(t.Context(), []byte("fixture text")); err != nil {
				t.Fatal(err)
			}
			data, err := socket.Read(t.Context())
			if binary {
				if !errors.Is(err, ErrVoiceConnection) {
					t.Fatal("binary frame crossed the JSON event boundary", err)
				}
			} else if err != nil || string(data) != "fixture reply" {
				t.Fatal("text frame changed", err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if _, err := socket.Read(t.Context()); err == nil {
				t.Fatal("closed socket returned a successful event")
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) }))
	defer server.Close()
	if _, err := dialVoice(t.Context(), "ws"+strings.TrimPrefix(server.URL, "http"), fixtureVoiceKey); !errors.Is(err, ErrVoiceConnection) {
		t.Fatal("failed WebSocket handshake was not classified", err)
	}
}

type voiceReadFailure struct{}

func (voiceReadFailure) Read([]byte) (int, error) { return 0, errors.New("isolated read failure") }
func (voiceReadFailure) Close() error             { return nil }

func TestCreateCallAndHangupClassifyProviderFailuresWithoutLeakingBodies(t *testing.T) {
	for _, test := range []struct {
		name     string
		status   int
		location string
		body     io.ReadCloser
		err      error
	}{
		{"transport", 0, "", nil, errors.New("isolated transport failure")},
		{"status", 401, "", io.NopCloser(strings.NewReader("not exposed")), nil},
		{"location", 201, "https://foreign.invalid/rtc_wrong", io.NopCloser(strings.NewReader(fixtureSDP)), nil},
		{"body failure", 201, voiceAPI + "/rtc_fixture", voiceReadFailure{}, nil},
		{"invalid answer", 201, voiceAPI + "/rtc_fixture", io.NopCloser(strings.NewReader("invalid SDP")), nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			api := &API{ctx: t.Context(), options: APIOptions{HTTP: voiceHTTPFunc(func(*http.Request) (*http.Response, error) {
				if test.err != nil {
					return nil, test.err
				}
				return &http.Response{StatusCode: test.status, Header: http.Header{"Location": []string{test.location}}, Body: test.body}, nil
			})}}
			session := &apiSession{key: fixtureVoiceKey, voice: "marin"}
			api.session = session
			if _, err := api.createCall(t.Context(), session, fixtureSDP); err == nil || strings.Contains(err.Error(), "not exposed") || strings.Contains(err.Error(), "isolated") {
				t.Fatal("failed call escaped its safe classified boundary", err)
			}
		})
	}
	for _, test := range []struct {
		status int
		err    error
		ok     bool
	}{{200, nil, true}, {404, nil, true}, {410, nil, true}, {500, nil, false}, {0, errors.New("isolated transport failure"), false}} {
		api := &API{ctx: context.Background(), options: APIOptions{HangupTimeout: defaultMediaStopTimeout, HTTP: voiceHTTPFunc(func(*http.Request) (*http.Response, error) {
			if test.err != nil {
				return nil, test.err
			}
			return &http.Response{StatusCode: test.status, Body: io.NopCloser(strings.NewReader(""))}, nil
		})}}
		if err := api.hangupRemote("rtc_fixture", fixtureVoiceKey); (err == nil) != test.ok {
			t.Fatal("remote stop proof was incorrectly classified", err)
		}
		if err := api.hangup(&apiSession{}); err != nil {
			t.Fatal("unsubmitted session caused a remote stop", err)
		}
	}
}
