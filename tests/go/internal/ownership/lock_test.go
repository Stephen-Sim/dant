package ownership

import (
	"context"
	"errors"
	"testing"
)

func TestSingleDataOwnerAndReleasedOwnership(t *testing.T) {
	directory := t.TempDir()
	first, err := Acquire(t.Context(), directory)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if !first.Current() {
		t.Fatal("new owner is not current")
	}
	if second, err := Acquire(t.Context(), directory); !errors.Is(err, ErrBusy) || second != nil {
		t.Fatalf("second owner accepted: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if first.Current() {
		t.Fatal("closed owner remains current")
	}
	second, err := Acquire(t.Context(), directory)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
}

func TestCancelledStartupDoesNotAcquireOwnership(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if lock, err := Acquire(ctx, t.TempDir()); !errors.Is(err, context.Canceled) || lock != nil {
		t.Fatalf("cancelled startup: %v", err)
	}
}
