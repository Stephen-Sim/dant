package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

type atomicFailureFile struct {
	*os.File
	failure string
	onClose func()
}

func (file *atomicFailureFile) Stat() (fs.FileInfo, error) {
	if file.failure == "stat" {
		return nil, io.ErrUnexpectedEOF
	}
	return file.File.Stat()
}

func (file *atomicFailureFile) Chmod(mode fs.FileMode) error {
	if file.failure == "chmod" {
		return io.ErrClosedPipe
	}
	return file.File.Chmod(mode)
}

func (file *atomicFailureFile) Write(data []byte) (int, error) {
	if file.failure == "write" {
		return 0, io.ErrClosedPipe
	}
	if file.failure == "short-write" {
		return file.File.Write(data[:len(data)-1])
	}
	return file.File.Write(data)
}

func (file *atomicFailureFile) Sync() error {
	if file.failure == "sync" {
		return io.ErrClosedPipe
	}
	return file.File.Sync()
}

func (file *atomicFailureFile) Close() error {
	err := file.File.Close()
	if file.onClose != nil {
		file.onClose()
	}
	if file.failure == "close" {
		return io.ErrClosedPipe
	}
	return err
}

func TestAtomicWriteFailurePreservesPreviousDestinationAndStopsPublication(t *testing.T) {
	for _, mode := range []string{"create", "stat", "chmod", "write", "short-write", "sync", "close", "capture-parent", "capture-source", "rename", "cancel-after-write"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			name := filepath.Join(directory, "state.json")
			old := []byte(`{"retained":true}`)
			if err := os.WriteFile(name, old, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			operations := newAtomicWriteIO()
			operations.createTemp = func(root, pattern string) (atomicWriteFile, error) {
				if mode == "create" {
					return nil, io.ErrClosedPipe
				}
				file, err := os.CreateTemp(root, pattern)
				if err != nil {
					return nil, err
				}
				result := &atomicFailureFile{File: file, failure: mode}
				if mode == "cancel-after-write" {
					result.onClose = cancel
				}
				return result, nil
			}
			captures := 0
			operations.capture = func(path string) (fs.FileInfo, error) {
				captures++
				if (mode == "capture-parent" && captures == 1) || (mode == "capture-source" && captures == 2) {
					return nil, io.ErrUnexpectedEOF
				}
				return CaptureIdentity(path)
			}
			renames := 0
			operations.rename = func(string, string) error {
				renames++
				return io.ErrClosedPipe
			}
			if err := writeAtomic(ctx, name, []byte(`{"new":true}`), 0600, operations); err == nil {
				t.Fatal("failed atomic operation was reported as committed")
			}
			actual, err := os.ReadFile(name)
			if err != nil || !bytes.Equal(actual, old) {
				t.Fatal("pre-commit failure replaced existing durable state")
			}
			wantRenames := 0
			if mode == "rename" {
				wantRenames = 1
			}
			if renames != wantRenames {
				t.Fatal("publication continued or retried after an unconfirmed preparation")
			}
			entries, err := os.ReadDir(directory)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "stat" {
				if len(entries) != 2 {
					t.Fatal("uncaptured temporary identity was unexpectedly deleted")
				}
			} else if len(entries) != 1 {
				t.Fatal("owned failed staging file was not cleaned up")
			}
		})
	}
}

func TestAtomicWriteCannotAdoptAReplacedSourceDestinationOrParent(t *testing.T) {
	for _, mode := range []string{"source", "destination", "parent"} {
		t.Run(mode, func(t *testing.T) {
			parent := t.TempDir()
			directory := filepath.Join(parent, "dynamic-data")
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(directory, "state.json")
			if err := os.WriteFile(name, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			operations := newAtomicWriteIO()
			captures := 0
			retained := ""
			replacement := ""
			operations.capture = func(path string) (fs.FileInfo, error) {
				identity, err := CaptureIdentity(path)
				captures++
				if err != nil || captures != 2 {
					return identity, err
				}
				replacement = path
				if mode == "destination" {
					replacement = name
				} else if mode == "parent" {
					replacement = directory
				}
				retained = replacement + ".retained"
				if err := os.Rename(replacement, retained); err != nil {
					t.Fatal(err)
				}
				if mode == "parent" {
					if err := os.Mkdir(replacement, 0700); err != nil {
						t.Fatal(err)
					}
					replacement = filepath.Join(replacement, "unowned.txt")
				}
				if err := os.WriteFile(replacement, []byte("unowned replacement"), 0600); err != nil {
					t.Fatal(err)
				}
				return identity, nil
			}
			if err := writeAtomic(t.Context(), name, []byte("candidate"), 0600, operations); !errors.Is(err, ErrFileChanged) {
				t.Fatal("atomic commit adopted a replacement identity", err)
			}
			if raw, err := os.ReadFile(replacement); err != nil || string(raw) != "unowned replacement" {
				t.Fatal("cleanup removed a replacement file or directory")
			}
			if _, err := os.Lstat(retained); err != nil {
				t.Fatal("cleanup removed retained original evidence")
			}
		})
	}
}
