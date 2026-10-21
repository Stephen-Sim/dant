package files

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

type attachmentWriteFaultFile struct {
	*os.File
	failure                      string
	writes, syncs, stats, closes int
}

func (file *attachmentWriteFaultFile) Write(data []byte) (int, error) {
	file.writes++
	if file.failure == "short write" {
		return file.File.Write(data[:len(data)-1])
	}
	if file.failure == "write" {
		_, _ = file.File.Write(data[:1])
		return 1, io.ErrClosedPipe
	}
	return file.File.Write(data)
}

func (file *attachmentWriteFaultFile) Sync() error {
	file.syncs++
	if file.failure == "sync" {
		return io.ErrClosedPipe
	}
	return file.File.Sync()
}

func (file *attachmentWriteFaultFile) Stat() (fs.FileInfo, error) {
	file.stats++
	if file.failure == "stat" {
		return nil, io.ErrUnexpectedEOF
	}
	return file.File.Stat()
}

func (file *attachmentWriteFaultFile) Close() error {
	file.closes++
	err := file.File.Close()
	if file.failure == "close" {
		return io.ErrClosedPipe
	}
	return err
}

func TestAttachmentExclusiveWriterRejectsTheConsumersShortWriteContract(t *testing.T) {
	name := filepath.Join(t.TempDir(), "owned.bin")
	file, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	failure := &attachmentWriteFaultFile{File: file, failure: "short write"}
	identity, err := writeExclusiveFile(failure, []byte("complete content"))
	if !errors.Is(err, io.ErrShortWrite) || identity == nil || failure.writes != 1 || failure.syncs != 0 || failure.stats != 1 || failure.closes != 1 {
		t.Fatal("consumer accepted or retried a short successful writer result", err)
	}
	removeOwned(name, identity)
	if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed write did not expose the exact identity required for owned cleanup", err)
	}
}

func TestAttachmentExclusivePersistenceFailuresKeepOnlyUnconfirmedFileIdentities(t *testing.T) {
	for _, stage := range []string{"write", "sync", "stat", "close"} {
		for _, phase := range []int{1, 2} {
			t.Run(stage+string(rune('0'+phase)), func(t *testing.T) {
				store, err := OpenAttachmentStore(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				calls := 0
				var fault *attachmentWriteFaultFile
				store.write = func(name string, raw []byte) (fs.FileInfo, error) {
					calls++
					if calls != phase {
						return writeExclusive(name, raw)
					}
					file, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
					if err != nil {
						return nil, err
					}
					fault = &attachmentWriteFaultFile{File: file, failure: stage}
					return writeExclusiveFile(fault, raw)
				}
				if _, err := store.Put(t.Context(), "retained.txt", "", []byte("private content")); err == nil || fault == nil || fault.writes != 1 || fault.stats != 1 || fault.closes != 1 || calls != phase {
					t.Fatal("failed persistence was published or its uncertain operation was repeated", err)
				}
				entries, err := os.ReadDir(store.Directory())
				if err != nil {
					t.Fatal(err)
				}
				count := 0
				if stage == "stat" {
					count = 1
				}
				if len(entries) != count {
					t.Fatal("cleanup removed an uncaptured identity or retained a confirmed partial file")
				}
			})
		}
	}
}
