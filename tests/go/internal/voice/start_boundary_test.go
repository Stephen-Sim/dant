package voice

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestAPIStartRejectsInvalidInputsAndJoinsFailedProviderSetup(t *testing.T) {
	if _, err := NewAPI(t.Context(), APIOptions{}); !errors.Is(err, ErrCallInput) {
		t.Fatal("missing API capabilities accepted", err)
	}
	for _, test := range []struct {
		name   string
		input  APIStart
		change func(*API)
		want   error
	}{
		{"SDP", APIStart{SDP: "invalid"}, nil, ErrCallInput},
		{"voice", APIStart{SDP: fixtureSDP, Voice: "unknown"}, nil, ErrCallInput},
		{"call identity", APIStart{SDP: fixtureSDP, CallID: "bad\x00id"}, nil, ErrCallInput},
		{"key read", APIStart{SDP: fixtureSDP}, func(api *API) {
			api.options.GetKey = func(context.Context) (string, error) { return "", errors.New("isolated key read failure") }
		}, ErrVoiceKey},
		{"key validation", APIStart{SDP: fixtureSDP, Key: "bad"}, nil, ErrVoiceKey},
		{"context read", APIStart{SDP: fixtureSDP}, func(api *API) {
			api.options.Context = func(context.Context, bool) (string, error) { return "", errors.New("isolated reference failure") }
		}, ErrVoiceContext},
		{"sideband dial", APIStart{SDP: fixtureSDP}, func(api *API) {
			api.options.Dial = func(context.Context, string, string) (VoiceSocket, error) {
				return nil, errors.New("isolated socket failure")
			}
		}, ErrVoiceConnection},
	} {
		t.Run(test.name, func(t *testing.T) {
			api, _, _ := apiFixture(t, APIOptions{})
			if test.change != nil {
				test.change(api)
			}
			if _, err := api.Start(t.Context(), test.input); !errors.Is(err, test.want) {
				t.Fatal("invalid startup lost safe classification", err)
			}
			if api.Snapshot().Call != nil {
				t.Fatal("failed provider setup retained visible active media")
			}
			if err := api.Close(t.Context()); err != nil {
				t.Fatal("failed setup did not join its cleanup owner", err)
			}
		})
	}
	api, _, _ := apiFixture(t, APIOptions{})
	if err := api.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := api.Start(t.Context(), APIStart{SDP: fixtureSDP}); !errors.Is(err, ErrVoiceClosed) {
		t.Fatal("disposed API provider restarted", err)
	}
}

func TestNativePendingWorkAndPauseRetainEveryUnsettledOwner(t *testing.T) {
	native, s, _ := continuationFixture(t)
	if native.PendingWork() {
		t.Fatal("idle call invented pending work")
	}
	s.callInputs["input"] = &nativeInput{}
	if !native.PendingWork() {
		t.Fatal("unsettled typed input was ignored")
	}
	s.callInputs["input"].settled = true
	s.turns["turn"] = &nativeTurn{owner: work.ToolContext{TurnID: "turn"}}
	if !native.PendingWork() {
		t.Fatal("unfinished native turn was ignored")
	}
	before := s.workEpoch
	if err := native.PauseWork(t.Context()); err != nil || s.pausing || s.workEpoch != before+1 || native.options.Engine.(*nativeFixtureEngine).paused.Load() != 1 {
		t.Fatal("native pause lost captured execution ownership", err)
	}
	s.turns["turn"].done = true
	if native.PendingWork() {
		t.Fatal("settled native call retained fake pending work")
	}
	s.unknown = true
	if !native.PendingWork() {
		t.Fatal("unknown native call became idle")
	}
	if err := native.Stop(t.Context(), s.mediaID); !errors.Is(err, ErrNativeStop) {
		t.Fatal("unknown media was treated as safely stopped", err)
	}
	native.session = nil
	if err := native.PauseWork(t.Context()); err != nil || native.PendingWork() {
		t.Fatal("absent native session invented unfinished work", err)
	}
	if _, err := NewNative(t.Context(), NativeOptions{}); !errors.Is(err, ErrCallInput) {
		t.Fatal("missing native capabilities accepted", err)
	}
}
