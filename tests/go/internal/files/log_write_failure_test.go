package files

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

type logWriteFaultFile struct {
	*os.File
	failure                  string
	stats, writes, truncates int
	afterWrite               func() error
	beforeWrite              func()
}

func (file *logWriteFaultFile) Stat() (fs.FileInfo, error) {
	file.stats++
	if file.failure == "opened stat" || file.failure == "written stat" && file.stats > 1 {
		return nil, io.ErrUnexpectedEOF
	}
	info, err := file.File.Stat()
	if file.beforeWrite != nil {
		file.beforeWrite()
	}
	return info, err
}

func (file *logWriteFaultFile) Write(raw []byte) (int, error) {
	file.writes++
	if file.failure == "write" {
		return 0, io.ErrClosedPipe
	}
	if _, err := file.File.Seek(0, io.SeekEnd); err != nil {
		return 0, err
	}
	if file.failure == "short write" {
		raw = raw[:len(raw)-1]
	}
	count, err := file.File.Write(raw)
	if err == nil && file.afterWrite != nil {
		err = file.afterWrite()
	}
	return count, err
}

func (file *logWriteFaultFile) Truncate(size int64) error {
	file.truncates++
	if file.failure == "truncate" {
		return io.ErrClosedPipe
	}
	return file.File.Truncate(size)
}

func (file *logWriteFaultFile) WriteAt(raw []byte, offset int64) (int, error) {
	file.writes++
	if file.failure == "write" {
		return 0, io.ErrClosedPipe
	}
	if file.failure == "short write" {
		raw = raw[:len(raw)-1]
	}
	count, err := file.File.WriteAt(raw, offset)
	if err == nil && file.afterWrite != nil {
		err = file.afterWrite()
	}
	return count, err
}

func TestOpenedLogsKeepNativeIdentityAndDoNotReplayFailedOrUnconfirmedWrites(t *testing.T) {
	for _, reset := range []bool{false, true} {
		for _, failure := range []string{"success", "opened stat", "closed before", "foreign before", "linked before", "cancelled before write", "write", "short write", "current missing", "linked after", "closed after", "parent closed", "replaced", "current error", "written stat", "truncate"} {
			if !reset && failure == "truncate" || reset && failure == "written stat" {
				continue
			}
			t.Run(map[bool]string{false: "append", true: "reset"}[reset]+"/"+failure, func(t *testing.T) {
				directory := t.TempDir()
				name := filepath.Join(directory, "startup.log")
				if err := os.WriteFile(name, []byte("original"), 0600); err != nil {
					t.Fatal(err)
				}
				root, err := OpenManagedRoot(directory, false)
				if err != nil {
					t.Fatal(err)
				}
				defer root.Close()
				file, err := openReadSnapshotFixture(name)
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				before, err := file.Stat()
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				fault := &logWriteFaultFile{File: file, failure: failure}
				write := logWrite{file: fault, before: before, current: func() (fs.FileInfo, error) { return root.root.Lstat("startup.log") }, unchanged: root.Unchanged}
				switch failure {
				case "closed before":
					if err := file.Close(); err != nil {
						t.Fatal(err)
					}
				case "foreign before":
					other := filepath.Join(directory, "other")
					if err := os.WriteFile(other, []byte("original"), 0600); err != nil {
						t.Fatal(err)
					}
					write.before, err = CaptureIdentity(other)
					if err != nil {
						t.Fatal(err)
					}
				case "linked before":
					if err := os.Link(name, name+"-linked"); err != nil {
						t.Fatal(err)
					}
				case "cancelled before write":
					fault.beforeWrite = cancel
				case "current error":
					write.current = func() (fs.FileInfo, error) { return nil, io.ErrUnexpectedEOF }
				}
				fault.afterWrite = func() error {
					switch failure {
					case "current missing":
						return os.Remove(name)
					case "linked after":
						return os.Link(name, name+"-linked")
					case "closed after":
						return file.Close()
					case "parent closed":
						return root.Close()
					case "replaced":
						if err := os.Rename(name, name+"-retained"); err != nil {
							return err
						}
						return os.WriteFile(name, []byte("replacement must survive"), 0600)
					}
					return nil
				}
				if reset {
					err = write.reset(ctx, []byte("new record"))
				} else {
					err = write.append(ctx, []byte("new record"))
				}
				if failure == "success" {
					want := "originalnew record"
					if reset {
						want = "new record"
					}
					if raw, readErr := os.ReadFile(name); err != nil || readErr != nil || string(raw) != want || fault.writes != 1 {
						t.Fatal("stable native log write lost its exact content", err, readErr)
					}
					return
				}
				wanted := ErrFileChanged
				if failure == "write" || failure == "truncate" {
					wanted = io.ErrClosedPipe
				} else if failure == "short write" {
					wanted = io.ErrShortWrite
				} else if failure == "cancelled before write" {
					wanted = context.Canceled
				}
				if !errors.Is(err, wanted) || fault.writes > 1 || fault.truncates > 1 {
					t.Fatal("unconfirmed native log operation was acknowledged or replayed", err)
				}
				if failure == "replaced" {
					if raw, err := os.ReadFile(name); err != nil || string(raw) != "replacement must survive" {
						t.Fatal("rejected log publication removed its replacement", err)
					}
				}
			})
		}
	}
}
