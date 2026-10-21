package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestManagedRenameRetryStopsWhenAnyOwnershipProofChanges(t *testing.T) {
	for _, mode := range []string{"exhausted", "cancel-wait", "source-missing", "source-changed", "parent-missing", "parent-changed", "destination-created"} {
		t.Run(mode, func(t *testing.T) {
			parent := t.TempDir()
			directory := filepath.Join(parent, "dynamic-data")
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(directory, "source")
			destination := filepath.Join(directory, "destination")
			if err := os.WriteFile(source, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			calls := 0
			retained := source
			rename := func(string, string) error {
				calls++
				if calls != 1 {
					return windows.ERROR_SHARING_VIOLATION
				}
				switch mode {
				case "source-missing", "source-changed":
					retained = source + ".retained"
					if err := os.Rename(source, retained); err != nil {
						t.Fatal(err)
					}
					if mode == "source-changed" {
						if err := os.WriteFile(source, []byte("replacement"), 0600); err != nil {
							t.Fatal(err)
						}
					}
				case "parent-missing", "parent-changed":
					retained = filepath.Join(directory+".retained", "source")
					if err := os.Rename(directory, directory+".retained"); err != nil {
						t.Fatal(err)
					}
					if mode == "parent-changed" {
						if err := os.Mkdir(directory, 0700); err != nil {
							t.Fatal(err)
						}
					}
				case "destination-created":
					if err := os.WriteFile(destination, []byte("unowned"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				return windows.ERROR_SHARING_VIOLATION
			}
			waits := 0
			wait := func(ctx context.Context, attempt int) error {
				if attempt != waits {
					t.Fatal("managed retry count changed")
				}
				waits++
				if mode == "cancel-wait" {
					cancel()
					return ctx.Err()
				}
				return nil
			}
			err := renameManaged(ctx, source, destination, nil, rename, wait)
			if mode == "exhausted" {
				if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) || calls != RenameAttempts || waits != RenameAttempts-1 {
					t.Fatal("retry did not stop at its fixed limit", err)
				}
			} else {
				want := ErrFileChanged
				if mode == "cancel-wait" {
					want = context.Canceled
				}
				if !errors.Is(err, want) || calls != 1 || waits != 1 {
					t.Fatal("retry continued after cancellation or changed ownership", err)
				}
			}
			if raw, err := os.ReadFile(retained); err != nil || string(raw) != "original" {
				t.Fatal("failed rename changed original file bytes")
			}
			if mode == "destination-created" {
				if raw, err := os.ReadFile(destination); err != nil || string(raw) != "unowned" {
					t.Fatal("retry overwrote an unowned destination")
				}
			}
		})
	}
}
