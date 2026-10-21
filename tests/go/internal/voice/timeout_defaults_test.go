package voice

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestProviderLifecycleDefaultsShareBudgetsWithoutChangingAcceptedRanges(t *testing.T) {
	persistence, err := store.Open(t.TempDir(), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(persistence.Close)

	apiOptions := APIOptions{
		GetKey: func(context.Context) (string, error) { return "", ErrVoiceKey },
		RunTask: func(context.Context, string, work.ToolContext) (json.RawMessage, error) {
			t.Fatal("constructing a voice provider executed a task")
			return nil, ErrCallInput
		},
		Tool: func(context.Context, string, contracts.RawObject, work.ToolContext) (json.RawMessage, error) {
			t.Fatal("constructing a voice provider executed a tool")
			return nil, ErrCallInput
		},
	}
	nativeOptions := NativeOptions{
		Worker: &nativeFixtureWorker{},
		Engine: &nativeFixtureEngine{state: persistence},
		Store:  persistence,
	}

	api, err := NewAPI(t.Context(), apiOptions)
	if err != nil {
		t.Fatal(err)
	}
	native, err := NewNative(t.Context(), nativeOptions)
	if err != nil {
		t.Fatal(err)
	}
	if api.options.ConnectTimeout != 15*time.Second || native.options.ConnectTimeout != api.options.ConnectTimeout {
		t.Fatal("provider connection defaults diverged")
	}
	if api.options.HangupTimeout != 10*time.Second || native.options.StopTimeout != api.options.HangupTimeout {
		t.Fatal("provider media-stop defaults diverged")
	}
	if api.options.ContextTimeout != 5*time.Second || native.options.ContextTimeout != api.options.ContextTimeout {
		t.Fatal("provider context defaults diverged")
	}

	queue, err := NewContextQueue(t.Context(), ContextQueueOptions{
		CallID:    "fixture-call",
		IsCurrent: func() bool { return true },
		Send: func(context.Context, ContextInput) error {
			t.Fatal("constructing an empty context queue sent an input")
			return ErrCallInput
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := queue.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	if queue.options.Timeout != api.options.ContextTimeout {
		t.Fatal("reference queue uses a different context default")
	}

	apiOptions.ConnectTimeout = 2 * time.Minute
	if _, err := NewAPI(t.Context(), apiOptions); err != nil {
		t.Fatal("API provider lost its longer supported timeout range")
	}
	nativeOptions.ConnectTimeout = 2 * time.Minute
	if _, err := NewNative(t.Context(), nativeOptions); !errors.Is(err, ErrCallInput) {
		t.Fatal("native provider accepted an API-only timeout range")
	}

	for _, timeout := range []time.Duration{time.Nanosecond, 5*time.Minute + time.Nanosecond} {
		apiOptions.ConnectTimeout = timeout
		if _, err := NewAPI(t.Context(), apiOptions); !errors.Is(err, ErrCallInput) {
			t.Fatal("API provider changed its validated timeout bounds")
		}
	}
	for _, timeout := range []time.Duration{time.Nanosecond, time.Minute + time.Nanosecond} {
		nativeOptions.ConnectTimeout = timeout
		if _, err := NewNative(t.Context(), nativeOptions); !errors.Is(err, ErrCallInput) {
			t.Fatal("native provider changed its validated timeout bounds")
		}
	}
}
