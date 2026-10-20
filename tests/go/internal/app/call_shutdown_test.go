package app

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

func TestWorkerCloseJoinsSpontaneousCallHistoryBeforeReleasingItsData(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		entered := make(chan struct{})
		release := make(chan struct{})
		written := make(chan struct{})
		var enteredOnce, releaseOnce sync.Once
		defer releaseOnce.Do(func() { close(release) })
		var armed atomic.Bool
		app, socket, callID, _ := activeAPICallFixture(t, func(options *WorkerOptions) {
			options.StoreOptions.Write = func(ctx context.Context, name string, raw []byte, mode fs.FileMode) error {
				var state contracts.State
				if err := json.Unmarshal(raw, &state); err != nil {
					return err
				}
				history := false
				for _, message := range state.Messages {
					history = history || message.Kind == "call"
				}
				if history && armed.Load() {
					enteredOnce.Do(func() { close(entered) })
					<-release
					defer close(written)
				}
				return files.WriteAtomic(ctx, name, raw, mode)
			}
		})
		armed.Store(true)
		if err := socket.Close(); err != nil {
			t.Fatal(err)
		}
		<-entered
		closed := make(chan struct{})
		go func() {
			app.Close()
			close(closed)
		}()
		synctest.Wait()
		select {
		case <-closed:
			t.Fatal("Worker close released its data while acknowledged call history was still writing")
		default:
		}
		releaseOnce.Do(func() { close(release) })
		<-written
		<-closed

		raw, err := os.ReadFile(filepath.Join(app.options.Startup.DataDir, "state.json"))
		if err != nil {
			t.Fatal(err)
		}
		var state contracts.State
		if err := json.Unmarshal(raw, &state); err != nil {
			t.Fatal(err)
		}
		calls := 0
		for _, message := range state.Messages {
			if message.Kind == "call" && message.CallID == callID {
				calls++
			}
		}
		if calls != 1 {
			t.Fatal("joined shutdown lost or duplicated the accepted call history")
		}
		app.Close()
	})
}
