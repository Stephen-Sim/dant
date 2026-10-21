package ownership

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type acquisitionContext struct {
	context.Context
	checks int
	after  func()
}

func (ctx *acquisitionContext) Err() error {
	ctx.checks++
	if ctx.checks == 2 {
		ctx.after()
	}
	return ctx.Context.Err()
}

func TestAcquisitionReleasesItsOSLockWhenTheFinalOwnershipFenceFails(t *testing.T) {
	for _, mode := range []string{"cancelled", "linked"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			underlying, cancel := context.WithCancel(t.Context())
			defer cancel()
			link := filepath.Join(directory, "unowned-lock-link")
			ctx := &acquisitionContext{Context: underlying}
			ctx.after = func() {
				if mode == "cancelled" {
					cancel()
					return
				}
				if err := os.Link(filepath.Join(directory, lockName), link); err != nil {
					t.Fatal(err)
				}
			}

			lock, err := Acquire(ctx, directory)
			wanted := ErrChanged
			if mode == "cancelled" {
				wanted = context.Canceled
			}
			if lock != nil || !errors.Is(err, wanted) {
				if lock != nil {
					lock.Close()
				}
				t.Fatal("failed final ownership fence published an owner", err)
			}
			if mode == "linked" {
				if err := os.Remove(link); err != nil {
					t.Fatal(err)
				}
			}

			// Reacquiring the actual OS lock proves failure released its handle.
			replacement, err := Acquire(t.Context(), directory)
			if err != nil || replacement == nil || !replacement.Current() {
				t.Fatal("failed acquisition retained a live OS owner", err)
			}
			if err := replacement.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
