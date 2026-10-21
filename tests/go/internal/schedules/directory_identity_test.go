package schedules

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestScheduleDirectoryReplacementIsRejectedEvenWhenTheOriginalDatabaseReturns(t *testing.T) {
	db := isolatedScheduleDatabase(t)
	retained := db.dir + "-retained"
	if err := os.Rename(db.dir, retained); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(db.dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(retained, filepath.Base(db.file)), db.file); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(db.dir, "replacement.bin")
	if err := os.WriteFile(marker, []byte("independent replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Snapshot(t.Context()); !errors.Is(err, ErrInvalid) {
		t.Fatal("an original database file authorized a replacement parent directory", err)
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "independent replacement" {
		t.Fatal("rejected database access altered unrelated replacement evidence", err)
	}
}
