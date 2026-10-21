package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWritePreservesOldFileOnCancellationAndRejectsLinks(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "state.json")
	if err := WriteAtomic(context.Background(), file, []byte(`{"revision":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := WriteAtomic(ctx, file, []byte(`{"revision":2}`), 0o600); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled write changed persistence")
	}
	data, err := ReadRegular(file, 1024)
	if err != nil || string(data) != `{"revision":1}` {
		t.Fatal("old state not retained")
	}
	linked := filepath.Join(directory, "linked.json")
	if err := os.Link(file, linked); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadRegular(file, 1024); err == nil {
		t.Fatal("hard-linked data accepted")
	}
	if err := WriteAtomic(context.Background(), file, []byte("changed"), 0o600); err == nil {
		t.Fatal("hard-linked target accepted")
	}
	data, err = os.ReadFile(linked)
	if err != nil || string(data) != `{"revision":1}` {
		t.Fatal("linked destination was modified")
	}
}

func TestManagedFilesBoundReadsAndLeaveNoStagingFiles(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "nested", "state.json")
	if err := WriteAtomic(context.Background(), file, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(context.Background(), file, []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}
	if data, err := ReadRegular(file, 6); err != nil || string(data) != "second" {
		t.Fatal("atomic replacement failed")
	}
	if _, err := ReadRegular(file, 5); !errors.Is(err, ErrFileLimit) {
		t.Fatal("oversized read accepted")
	}
	entries, err := os.ReadDir(filepath.Dir(file))
	if err != nil || len(entries) != 1 || entries[0].Name() != "state.json" {
		t.Fatal("write staging leaked")
	}
	if _, err := OrdinaryDirectory("relative", true); !errors.Is(err, ErrManagedPath) {
		t.Fatal("relative managed path accepted")
	}
}

func TestManagedDirectoriesRejectAncestorLinks(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symbolic links unavailable for this isolated fixture")
	}
	if _, err := OrdinaryDirectory(filepath.Join(link, "child"), true); !errors.Is(err, ErrManagedPath) {
		t.Fatal("ancestor link traversed")
	}
	if _, err := os.Stat(filepath.Join(target, "child")); !os.IsNotExist(err) {
		t.Fatal("directory created through link")
	}
}
