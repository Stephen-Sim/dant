package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestManagedOperationsRejectInvalidPathsClosedRootsAndMissingParents(t *testing.T) {
	directory := t.TempDir()
	root, err := OpenManagedRoot(directory, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, invalid := range []string{"../outside", "a/../../outside", "", "."} {
		for _, run := range []func() error{
			func() error { _, err := root.OpenLockFile(invalid); return err },
			func() error { _, err := root.OrdinaryFile(invalid); return err },
			func() error { return root.AppendFile(t.Context(), invalid, nil, 100) },
			func() error { return root.ResetLog(t.Context(), invalid, nil) },
		} {
			if err := run(); err == nil {
				t.Fatal("invalid managed path was accepted", invalid)
			}
		}
	}
	for _, name := range []string{"missing", filepath.Join("missing", "child", "file")} {
		for _, run := range []func() error{
			func() error { _, err := root.ReadFile(t.Context(), name, 100); return err },
			func() error { _, err := root.ReadDirectory(name); return err },
			func() error { _, err := root.OrdinaryFile(name); return err },
			func() error { return root.AppendFile(t.Context(), name, nil, 100) },
			func() error { return root.ResetLog(t.Context(), name, nil) },
		} {
			if err := run(); err == nil {
				t.Fatal("missing managed file or ancestor was accepted", name)
			}
		}
	}
	if _, err := root.ReadDirectory("../outside"); !errors.Is(err, ErrManagedPath) {
		t.Fatal("directory traversal was accepted", err)
	}
	if err := root.WithReader(t.Context(), "fixture", 100, nil); !errors.Is(err, ErrManagedPath) {
		t.Fatal("a missing streaming consumer was accepted", err)
	}
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	for _, run := range []func() error{
		func() error { _, err := root.OpenLockFile("lock"); return err },
		func() error { _, err := root.ReadDirectory("."); return err },
		func() error { _, err := root.OrdinaryFile("file"); return err },
	} {
		if err := run(); err == nil {
			t.Fatal("a released directory capability was reused")
		}
	}
	if err := root.Close(); err != nil {
		t.Fatal("a second close was not idempotent", err)
	}
}

func TestManagedStreamingCancellationMutationAndIncompleteReadsNeverConfirmAFile(t *testing.T) {
	for _, action := range []string{"cancel", "consumer-error", "incomplete", "mutate"} {
		t.Run(action, func(t *testing.T) {
			directory := t.TempDir()
			name := filepath.Join(directory, "result.txt")
			if err := os.WriteFile(name, []byte("original contents"), 0o600); err != nil {
				t.Fatal(err)
			}
			root, err := OpenManagedRoot(directory, false)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			failure := errors.New("synthetic consumer failure")
			err = root.WithReader(ctx, "result.txt", 100, func(reader io.Reader) error {
				switch action {
				case "cancel":
					cancel()
					_, err := io.Copy(io.Discard, reader)
					return err
				case "consumer-error":
					return failure
				case "incomplete":
					return nil
				case "mutate":
					if _, err := io.Copy(io.Discard, reader); err != nil {
						return err
					}
					return os.WriteFile(name, []byte("replacement"), 0o600)
				}
				return nil
			})
			if action == "cancel" && !errors.Is(err, context.Canceled) || action == "consumer-error" && !errors.Is(err, failure) || (action == "incomplete" || action == "mutate") && !errors.Is(err, ErrFileChanged) {
				t.Fatal("unconfirmed streaming read was accepted or misclassified", err)
			}
		})
	}
}

func TestAnchoredLogAndLockOperationsPreserveBoundsAndFileIdentity(t *testing.T) {
	directory := t.TempDir()
	root, err := OpenManagedRoot(directory, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	lock, err := root.OpenLockFile("lock")
	if err != nil || !SingleLink(lock) {
		t.Fatal("ordinary lock was not created", err)
	}
	if err := lock.Close(); err != nil || SingleLink(lock) {
		t.Fatal("closed lock handle remained eligible", err)
	}
	lock, err = root.OpenLockFile("lock")
	if err != nil {
		t.Fatal("existing anchored lock was not reopened", err)
	}
	lock.Close()
	if err := os.Mkdir(filepath.Join(directory, "folder"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := root.OpenLockFile("folder"); err == nil {
		t.Fatal("directory was opened as an ordinary lock", err)
	}
	if ordinary, err := root.OrdinaryFile("folder"); err != nil || ordinary {
		t.Fatal("directory was eligible for file delivery", err)
	}
	file := filepath.Join(directory, "startup.log")
	if err := os.WriteFile(file, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(file)
	if err := root.ResetLog(t.Context(), "startup.log", []byte("marker")); err != nil {
		t.Fatal(err)
	}
	if err := root.AppendFile(t.Context(), "startup.log", []byte("\nrecord"), 13); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(file); err != nil || !bytes.Equal(raw, []byte("marker\nrecord")) {
		t.Fatal("bounded append changed the log", err)
	}
	after, _ := os.Stat(file)
	if !os.SameFile(before, after) {
		t.Fatal("log reset replaced the inherited handle's identity")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	for _, run := range []func() error{
		func() error { return root.AppendFile(cancelled, "startup.log", nil, 100) },
		func() error { return root.ResetLog(cancelled, "startup.log", nil) },
		func() error { return root.AppendFile(t.Context(), "startup.log", []byte("overflow"), 13) },
		func() error { return root.AppendFile(t.Context(), "folder", nil, 100) },
		func() error { return root.ResetLog(t.Context(), "folder", nil) },
		func() error { return root.ResetLog(t.Context(), "startup.log", make([]byte, 4097)) },
	} {
		if err := run(); err == nil {
			t.Fatal("invalid log operation was accepted")
		}
	}
	if err := os.Link(file, filepath.Join(directory, "linked.log")); err != nil {
		t.Fatal(err)
	}
	for _, run := range []func() error{
		func() error { return root.AppendFile(t.Context(), "startup.log", nil, 100) },
		func() error { return root.ResetLog(t.Context(), "startup.log", nil) },
		func() error { _, err := root.OpenLockFile("startup.log"); return err },
	} {
		if err := run(); !errors.Is(err, ErrFileChanged) {
			t.Fatal("multiply linked file was accepted", err)
		}
	}
}
