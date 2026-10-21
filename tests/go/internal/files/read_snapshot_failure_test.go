package files

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOpenedReadRequiresCompleteBytesAndTheSameFileAndDirectoryOwner(t *testing.T) {
	for _, mode := range []string{
		"success", "closed-before", "foreign-before", "linked-before", "consumer-error", "cancelled",
		"grown", "modified", "missing-path", "linked-after", "closed-parent", "incomplete", "closed-after",
	} {
		t.Run(mode, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "owned")
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(directory, "source")
			if err := os.WriteFile(name, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			file, err := openReadSnapshotFixture(name)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			before, err := file.Stat()
			if err != nil {
				t.Fatal(err)
			}
			parent, err := CaptureIdentity(directory)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			read := fileRead{
				file: file, before: before, maximum: before.Size(),
				current: func() (fs.FileInfo, error) { return os.Lstat(name) },
				unchanged: func() bool {
					current, err := CaptureIdentity(directory)
					return err == nil && os.SameFile(parent, current)
				},
			}
			var parentRoot *ManagedRoot
			if mode == "closed-parent" {
				parentRoot, err = OpenManagedRoot(directory, false)
				if err != nil {
					t.Fatal(err)
				}
				defer parentRoot.Close()
				read.unchanged = parentRoot.Unchanged
			}
			switch mode {
			case "closed-before":
				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
			case "foreign-before":
				other := filepath.Join(directory, "other")
				if err := os.WriteFile(other, []byte("original"), 0600); err != nil {
					t.Fatal(err)
				}
				read.before, err = CaptureIdentity(other)
				if err != nil {
					t.Fatal(err)
				}
			case "linked-before":
				if err := os.Link(name, name+".link"); err != nil {
					t.Fatal(err)
				}
			}

			identity, err := read.consume(ctx, func(reader io.Reader) error {
				if mode == "consumer-error" {
					return io.ErrClosedPipe
				}
				if mode == "cancelled" {
					cancel()
				}
				if mode == "incomplete" {
					_, err := io.CopyN(io.Discard, reader, 1)
					return err
				}
				if mode == "grown" {
					if _, err := file.WriteAt([]byte("!"), before.Size()); err != nil {
						return err
					}
				}
				if _, err := io.Copy(io.Discard, reader); err != nil {
					return err
				}
				switch mode {
				case "modified":
					if _, err := file.WriteAt([]byte("x"), 0); err != nil {
						return err
					}
					changed := before.ModTime().Add(time.Minute)
					return os.Chtimes(name, changed, changed)
				case "missing-path":
					return os.Remove(name)
				case "linked-after":
					return os.Link(name, name+".link")
				case "closed-parent":
					return parentRoot.Close()
				case "closed-after":
					return file.Close()
				}
				return nil
			})
			if mode == "success" {
				if err != nil || !os.SameFile(before, identity) {
					t.Fatal("complete stable read lost its opened identity", err)
				}
				return
			}
			wanted := ErrFileChanged
			if mode == "consumer-error" {
				wanted = io.ErrClosedPipe
			} else if mode == "cancelled" {
				wanted = context.Canceled
			} else if mode == "grown" {
				wanted = ErrFileLimit
			}
			if !errors.Is(err, wanted) || identity != nil {
				t.Fatal("unconfirmed read returned a successful identity", mode, err)
			}
		})
	}
}
