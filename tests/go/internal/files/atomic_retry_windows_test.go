package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestAtomicRenameRetryIsBoundedAndKeepsEveryCapturedIdentity(t *testing.T) {
	for _, mode := range []string{"exhausted", "cancel-wait", "source-changed", "destination-changed", "parent-changed"} {
		t.Run(mode, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "dynamic-data")
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(directory, "state.json")
			if err := os.WriteFile(name, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			operations := newAtomicWriteIO()
			renames, waits := 0, 0
			replacement := ""
			operations.rename = func(source, destination string) error {
				renames++
				if renames == 1 && (mode == "source-changed" || mode == "destination-changed" || mode == "parent-changed") {
					replacement = source
					if mode == "destination-changed" {
						replacement = destination
					} else if mode == "parent-changed" {
						replacement = directory
					}
					if err := os.Rename(replacement, replacement+".retained"); err != nil {
						t.Fatal(err)
					}
					if mode == "parent-changed" {
						if err := os.Mkdir(replacement, 0700); err != nil {
							t.Fatal(err)
						}
						replacement = filepath.Join(replacement, "unowned.txt")
					}
					if err := os.WriteFile(replacement, []byte("unowned replacement"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				return windows.ERROR_SHARING_VIOLATION
			}
			operations.wait = func(ctx context.Context, attempt int) error {
				if attempt != waits {
					t.Fatal("rename retry count changed")
				}
				waits++
				if mode == "cancel-wait" {
					cancel()
					return ctx.Err()
				}
				return nil
			}
			err := writeAtomic(ctx, name, []byte("candidate"), 0600, operations)
			if mode == "exhausted" {
				if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) || renames != RenameAttempts || waits != RenameAttempts-1 {
					t.Fatal("rename retry exceeded its fixed policy or hid exhaustion", err)
				}
			} else {
				want := ErrFileChanged
				if mode == "cancel-wait" {
					want = context.Canceled
				}
				if !errors.Is(err, want) || renames != 1 || waits != 1 {
					t.Fatal("retry ignored cancellation or a replaced identity", err)
				}
			}
			if replacement != "" {
				if raw, err := os.ReadFile(replacement); err != nil || string(raw) != "unowned replacement" {
					t.Fatal("failed retry removed an unowned replacement")
				}
			} else if raw, err := os.ReadFile(name); err != nil || string(raw) != "original" {
				t.Fatal("failed retry changed the durable destination")
			}
		})
	}
}
