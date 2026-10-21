package memory

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type markdownReadFailure struct {
	markdownReader
	readErr error
	read    io.Reader
	statAt  int
	statErr error
	changed fs.FileInfo
	stats   int
	closed  *int
}

func (file *markdownReadFailure) Read(data []byte) (int, error) {
	if file.readErr != nil {
		return 0, file.readErr
	}
	if file.read != nil {
		return file.read.Read(data)
	}
	return file.markdownReader.Read(data)
}
func (file *markdownReadFailure) Stat() (fs.FileInfo, error) {
	file.stats++
	if file.stats == file.statAt {
		if file.changed != nil {
			return file.changed, nil
		}
		return nil, file.statErr
	}
	return file.markdownReader.Stat()
}
func (file *markdownReadFailure) Close() error {
	*file.closed++
	return file.markdownReader.Close()
}

func TestMarkdownImportFailuresRetainSQLiteAuthorityAndOriginalSnapshotBytes(t *testing.T) {
	for _, phase := range []string{"lstat", "open", "opened stat", "opened identity", "read", "final stat", "changed size", "oversized", "invalid text"} {
		t.Run(phase, func(t *testing.T) {
			s := openStoreFixture(t)
			if err := s.WriteNote(t.Context(), "identity.md", "SQLite authority"); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(s.Directory(), "identity.md")
			original := []byte("authored snapshot")
			if err := os.WriteFile(file, original, 0600); err != nil {
				t.Fatal(err)
			}
			replacement := filepath.Join(t.TempDir(), "different.md")
			if err := os.WriteFile(replacement, []byte("a different longer snapshot"), 0600); err != nil {
				t.Fatal(err)
			}
			changed, err := os.Stat(replacement)
			if err != nil {
				t.Fatal(err)
			}
			disk := s.markdown
			closed, opened := 0, 0
			failure := errors.New("isolated markdown I/O failure")
			if phase == "lstat" {
				s.markdown.lstat = func(string) (fs.FileInfo, error) { return nil, failure }
			}
			s.markdown.open = func(path string) (markdownReader, error) {
				opened++
				if phase == "open" {
					return nil, failure
				}
				handle, err := disk.open(path)
				if err != nil {
					return nil, err
				}
				wrapped := &markdownReadFailure{markdownReader: handle, closed: &closed}
				switch phase {
				case "opened stat":
					wrapped.statAt, wrapped.statErr = 1, failure
				case "opened identity":
					wrapped.statAt, wrapped.changed = 1, changed
				case "read":
					wrapped.readErr = failure
				case "final stat":
					wrapped.statAt, wrapped.statErr = 2, failure
				case "changed size":
					wrapped.statAt, wrapped.changed = 2, changed
				case "oversized":
					wrapped.read = strings.NewReader(strings.Repeat("x", MaxNoteBytes+1))
				case "invalid text":
					wrapped.read = strings.NewReader("bad\x00text")
				}
				return wrapped, nil
			}
			if err := s.ImportMarkdown(t.Context(), "identity.md"); err == nil {
				t.Fatal("unconfirmed markdown read replaced SQLite authority")
			}
			if phase != "lstat" && opened != 1 || phase != "lstat" && phase != "open" && closed != 1 {
				t.Fatal("failed import retried its read or leaked its owned file")
			}
			text, err := s.ReadNote(t.Context(), "identity.md")
			raw, readErr := os.ReadFile(file)
			if err != nil || readErr != nil || text != "SQLite authority" || !bytes.Equal(raw, original) {
				t.Fatal("failed import changed durable memory or original snapshot bytes", err, readErr)
			}
		})
	}
}

type markdownBackupFailure struct {
	markdownBackupWriter
	phase  string
	closed *int
}

func (file markdownBackupFailure) Write(data []byte) (int, error) {
	if file.phase == "write" {
		return 0, errors.New("isolated backup write failure")
	}
	if file.phase == "short write" {
		return file.markdownBackupWriter.Write(data[:len(data)-1])
	}
	return file.markdownBackupWriter.Write(data)
}
func (file markdownBackupFailure) Sync() error {
	if file.phase == "sync" {
		return errors.New("isolated backup sync failure")
	}
	return file.markdownBackupWriter.Sync()
}
func (file markdownBackupFailure) Close() error {
	*file.closed++
	err := file.markdownBackupWriter.Close()
	if file.phase == "close" {
		return errors.New("isolated backup close failure")
	}
	return err
}

func TestMarkdownBackupFailuresKeepSourcesAndNeverPretendTheCopyCommitted(t *testing.T) {
	for _, phase := range []string{"mkdir", "create", "write", "short write", "sync", "close"} {
		t.Run(phase, func(t *testing.T) {
			s := openStoreFixture(t)
			file := filepath.Join(s.Directory(), "identity.md")
			before, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			disk := s.markdown
			created, closed := 0, 0
			if phase == "mkdir" {
				s.markdown.mkdir = func(string, fs.FileMode) error { return errors.New("isolated mkdir failure") }
			}
			s.markdown.create = func(path string) (markdownBackupWriter, error) {
				created++
				if phase == "create" {
					return nil, errors.New("isolated create failure")
				}
				handle, err := disk.create(path)
				if err != nil {
					return nil, err
				}
				return markdownBackupFailure{handle, phase, &closed}, nil
			}
			if err := s.backupNotes([]Note{{Name: "identity.md", Text: string(before)}}); err == nil {
				t.Fatal("incomplete backup was reported committed")
			}
			if phase != "mkdir" && created != 1 || phase != "mkdir" && phase != "create" && closed != 1 {
				t.Fatal("failed backup retried creation or leaked its file")
			}
			after, err := os.ReadFile(file)
			text, sqlErr := s.ReadNote(t.Context(), "identity.md")
			if err != nil || sqlErr != nil || !bytes.Equal(before, after) || text != string(before) {
				t.Fatal("backup failure changed its source or durable SQL authority", err, sqlErr)
			}
		})
	}
}

func TestMarkdownExportFailuresDoNotReplaceThePreviousSnapshot(t *testing.T) {
	for _, phase := range []string{"lstat", "not regular", "atomic write", "closed"} {
		t.Run(phase, func(t *testing.T) {
			s := openStoreFixture(t)
			file := filepath.Join(s.Directory(), "identity.md")
			before, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.WriteNote(t.Context(), "identity.md", "New durable SQL note"); err != nil {
				t.Fatal(err)
			}
			writes := 0
			s.markdown.writeAtomic = func(context.Context, string, []byte, fs.FileMode) error {
				writes++
				return errors.New("isolated atomic export failure")
			}
			switch phase {
			case "lstat":
				s.markdown.lstat = func(string) (fs.FileInfo, error) { return nil, fs.ErrPermission }
			case "not regular":
				info, err := os.Stat(s.Directory())
				if err != nil {
					t.Fatal(err)
				}
				s.markdown.lstat = func(string) (fs.FileInfo, error) { return info, nil }
			case "closed":
				s.Close()
			}
			if err := s.ExportMarkdown(t.Context(), "identity.md"); err == nil {
				t.Fatal("failed snapshot export was reported saved")
			}
			if phase == "atomic write" && writes != 1 || phase != "atomic write" && writes != 0 {
				t.Fatal("export ignored validation or retried an unknown write")
			}
			after, err := os.ReadFile(file)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("failed export replaced its previous snapshot", err)
			}
		})
	}
	s := openStoreFixture(t)
	if _, err := s.readMarkdown("../outside.md"); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("invalid import note name reached storage", err)
	}
	if err := s.writeMarkdown(t.Context(), "../outside.md", "data"); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("invalid export note name reached storage", err)
	}
	if err := s.writeMarkdown(t.Context(), "identity.md", "bad\x00text"); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("invalid snapshot text reached storage", err)
	}
}
