package store

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestStoreOpenCancellationWhileWaitingForTheSharedWriterDoesNotCreateState(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		previousGate := persistenceGate
		persistenceGate = make(chan struct{}, 1)
		defer func() { persistenceGate = previousGate }()

		directory := t.TempDir()
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		persistenceGate <- struct{}{}
		defer func() { <-persistenceGate }()

		done := make(chan error, 1)
		go func() {
			opened, err := OpenContext(ctx, directory, Options{})
			if opened != nil {
				opened.Close()
			}
			done <- err
		}()
		synctest.Wait()
		cancel()

		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatal("cancelled open acquired another writer's state transaction", err)
		}
	})
}

func TestStoreMutationWaitCancellationAndClosurePreserveItsCommittedSnapshot(t *testing.T) {
	s, _ := openFixture(t)
	before := s.Revision()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	persistenceGate <- struct{}{}
	err := s.Mutate(ctx, func(*contracts.State) error {
		t.Error("cancelled transaction reached its state mutation")
		return nil
	})
	<-persistenceGate
	if !errors.Is(err, context.Canceled) || s.Revision() != before {
		t.Fatal("cancelled writer changed the committed state", err)
	}

	s.Close()
	if err := s.Mutate(t.Context(), func(*contracts.State) error {
		t.Error("closed store reached its state mutation")
		return nil
	}); !errors.Is(err, ErrClosed) || s.Revision() != before {
		t.Fatal("closed store accepted a state mutation", err)
	}
}
