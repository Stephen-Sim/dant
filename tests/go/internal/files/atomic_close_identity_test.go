package files

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type atomicCommitFile struct {
	*os.File
	mode   string
	stats  int
	closes int
}

func (file *atomicCommitFile) Stat() (fs.FileInfo, error) {
	file.stats++
	if file.mode == "final-stat" && file.stats == 2 {
		return nil, io.ErrClosedPipe
	}
	return file.File.Stat()
}

func (file *atomicCommitFile) Sync() error {
	if err := file.File.Sync(); err != nil {
		return err
	}
	if file.mode == "changed-size" {
		_, err := file.File.Write([]byte("!"))
		return err
	}
	return nil
}

func (file *atomicCommitFile) Close() error {
	file.closes++
	if err := file.File.Close(); err != nil {
		return err
	}
	if file.mode == "changed-after-close" {
		if err := os.WriteFile(file.Name(), []byte("tampered!"), 0600); err != nil {
			return err
		}
		changed := time.Now().Add(time.Minute)
		return os.Chtimes(file.Name(), changed, changed)
	}
	return nil
}

func TestAtomicCommitRequiresItsOpenedWrittenSnapshotBeforePublication(t *testing.T) {
	for _, mode := range []string{"final-stat", "changed-size", "changed-after-close"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			destination := filepath.Join(directory, "state.json")
			if err := os.WriteFile(destination, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			operations := newAtomicWriteIO()
			var staged *atomicCommitFile
			operations.createTemp = func(root, pattern string) (atomicWriteFile, error) {
				file, err := os.CreateTemp(root, pattern)
				if err != nil {
					return nil, err
				}
				staged = &atomicCommitFile{File: file, mode: mode}
				return staged, nil
			}

			err := writeAtomic(t.Context(), destination, []byte("candidate"), 0600, operations)
			wanted := ErrFileChanged
			if mode == "final-stat" {
				wanted = io.ErrClosedPipe
			}
			if !errors.Is(err, wanted) || staged == nil || staged.closes != 1 {
				t.Fatal("unconfirmed written snapshot was committed or retained a handle", err)
			}
			if data, err := os.ReadFile(destination); err != nil || string(data) != "original" {
				t.Fatal("unconfirmed commit changed the original destination", err)
			}
			if entries, err := os.ReadDir(directory); err != nil || len(entries) != 1 {
				t.Fatal("failed commit retained owned staging files", err)
			}
		})
	}
}

func TestAtomicCommitCannotAdoptAFileReplacedBeforeIdentityRecapture(t *testing.T) {
	directory := t.TempDir()
	destination := filepath.Join(directory, "state.json")
	if err := os.WriteFile(destination, []byte("retained destination"), 0600); err != nil {
		t.Fatal(err)
	}
	operations := newAtomicWriteIO()
	var staged, retained string
	operations.createTemp = func(root, pattern string) (atomicWriteFile, error) {
		file, err := os.CreateTemp(root, pattern)
		if err != nil {
			return nil, err
		}
		staged, retained = file.Name(), file.Name()+".retained"
		return &atomicFailureFile{File: file, onClose: func() {
			if err := os.Rename(staged, retained); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(staged, []byte("unowned replacement"), 0600); err != nil {
				t.Fatal(err)
			}
		}}, nil
	}

	err := writeAtomic(t.Context(), destination, []byte("candidate"), 0600, operations)
	if data, readErr := os.ReadFile(destination); readErr != nil || string(data) != "retained destination" {
		t.Fatal("atomic commit published the replacement file", readErr)
	}
	if !errors.Is(err, ErrFileChanged) {
		t.Fatal("atomic commit accepted an identity it did not create", err)
	}
	if data, err := os.ReadFile(staged); err != nil || string(data) != "unowned replacement" {
		t.Fatal("atomic cleanup deleted the unowned replacement", err)
	}
	if data, err := os.ReadFile(retained); err != nil || string(data) != "candidate" {
		t.Fatal("atomic cleanup lost the original candidate evidence", err)
	}
}
