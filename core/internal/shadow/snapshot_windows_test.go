package shadow

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsSnapshotHandleDeniesConcurrentWriteAndDeleteSharing(t *testing.T) {
	file := fixtureSnapshot(t)
	value, err := openSnapshot(context.Background(), file)
	if err != nil {
		t.Fatal(err)
	}
	defer value.close()
	if writer, err := os.OpenFile(file, os.O_WRONLY, 0600); err == nil {
		writer.Close()
		t.Fatal("the immutable snapshot allowed another writer")
	}
	if err := os.Rename(file, filepath.Join(filepath.Dir(file), "replacement.sqlite")); err == nil {
		t.Fatal("the immutable snapshot allowed path replacement")
	}
	if err := os.Remove(file); err == nil {
		t.Fatal("the immutable snapshot allowed deletion")
	}
	if err := value.unchanged(); err != nil {
		t.Fatal("failed external writes invalidated unchanged snapshot bytes")
	}
	value.close()
	writer, err := os.OpenFile(file, os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal("the snapshot lock was not released on close")
	}
	writer.Close()
}
