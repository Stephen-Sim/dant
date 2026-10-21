package files

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestIdentityCaptureRefusesAnUnopenedClosedOrChangedFile(t *testing.T) {
	for _, mode := range []string{"open", "closed-handle", "path-unavailable", "path-replaced", "file-grew"} {
		t.Run(mode, func(t *testing.T) {
			name := filepath.Join(t.TempDir(), "identity.bin")
			original := []byte("original")
			if err := os.WriteFile(name, original, 0o600); err != nil {
				t.Fatal(err)
			}
			failure := errors.New("isolated identity observation unavailable")
			lstats := 0
			lstat := func(name string) (fs.FileInfo, error) {
				lstats++
				if mode == "path-unavailable" && lstats == 2 {
					return nil, failure
				}
				return os.Lstat(name)
			}
			var opened *os.File
			renameFenced := false
			open := func(name string) (identityHandle, error) {
				if mode == "open" {
					return nil, failure
				}
				file, err := os.Open(name)
				if err != nil {
					return nil, err
				}
				opened = file
				t.Cleanup(func() { _ = file.Close() })
				if mode == "closed-handle" {
					file.Close()
				}
				if mode == "path-replaced" {
					info, err := file.Stat()
					if err != nil {
						t.Fatal(err)
					}
					if err := os.Rename(name, name+".retained"); err != nil {
						if directoryRenameDenied(err) {
							renameFenced = true
							return file, nil
						}
						t.Fatal(err)
					}
					if err := os.WriteFile(name, []byte("replaced"), 0o600); err != nil {
						t.Fatal(err)
					}
					if err := os.Chtimes(name, info.ModTime(), info.ModTime()); err != nil {
						t.Fatal(err)
					}
				}
				if mode == "file-grew" {
					if err := os.WriteFile(name, []byte("changed and longer"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				return file, nil
			}
			info, err := captureIdentity(name, lstat, open)
			if renameFenced {
				if err != nil || info == nil {
					t.Fatal("native sharing protection lost the unchanged original identity", err)
				}
			} else if err == nil || info != nil {
				t.Fatal("unconfirmed handle or path supplied an identity", err)
			}
			if opened != nil {
				if _, err := opened.Read(make([]byte, 1)); !errors.Is(err, fs.ErrClosed) {
					t.Fatal("failed identity capture leaked its opened file", err)
				}
			}
			if mode == "path-replaced" && !renameFenced {
				if raw, err := os.ReadFile(name + ".retained"); err != nil || !bytes.Equal(raw, original) {
					t.Fatal("identity capture removed its unconfirmed original", err)
				}
				if raw, err := os.ReadFile(name); err != nil || string(raw) != "replaced" {
					t.Fatal("identity capture removed the replacement", err)
				}
			}
		})
	}
}

func TestManagedStreamingRejectsGrowthBeyondTheAuthenticatedReadBudget(t *testing.T) {
	name := filepath.Join(t.TempDir(), "growing.bin")
	if err := os.WriteFile(name, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := OpenManagedRoot(filepath.Dir(name), false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	err = root.WithReader(t.Context(), filepath.Base(name), 8, func(reader io.Reader) error {
		if err := os.WriteFile(name, bytes.Repeat([]byte("x"), 9), 0o600); err != nil {
			return err
		}
		_, err := io.Copy(io.Discard, reader)
		return err
	})
	if !errors.Is(err, ErrFileLimit) {
		t.Fatal("a growing file exceeded the retained read budget", err)
	}
}
