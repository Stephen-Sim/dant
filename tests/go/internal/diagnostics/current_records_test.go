package diagnostics

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestDiagnosticRecentIncludesCurrentWriterBesideRetainedVersions(t *testing.T) {
	directory := t.TempDir()
	now := time.Date(2026, time.October, 21, 12, 0, 0, 0, time.UTC)
	old := now.Add(-36 * time.Hour)
	legacyRecord := `{"event":"service.started","at":"` + iso(old) + `","role":"vm-worker","version":"0.4.7-beta.12"}` + "\n"
	for index := 1; index <= 8; index++ {
		id := fmt.Sprintf("00000000-0000-4000-8000-%012d", index)
		writeDiagnosticFixture(t, directory, id, old.Add(time.Duration(index)*time.Millisecond), strings.Repeat(legacyRecord, 64))
	}

	logger := newLogger(t, Options{
		DataDir: directory, Role: "vm-worker", Version: "0.4.7-beta.23",
		Now: func() time.Time { return now },
	})
	before := logger.Status()
	if before.Version == nil || *before.Version != "0.4.7-beta.23" || before.FileCount != 8 ||
		before.TotalBytes >= StartupLogBytes || before.LastError != nil || before.DroppedRecords != 0 {
		t.Fatal("retained diagnostics were not a healthy bounded fixture", before)
	}
	recent, err := logger.Recent(t.Context(), 50)
	if err != nil || len(recent) != 50 {
		t.Fatal("retained records were unavailable", err)
	}
	for _, record := range recent {
		if record.Version != "0.4.7-beta.12" {
			t.Fatal("logger status invented a current-version persisted event")
		}
	}

	if !logger.Log("service.started", Fields{}) {
		t.Fatal("current writer refused its startup event")
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	recent, err = logger.Recent(t.Context(), 50)
	if err != nil || len(recent) != 50 {
		t.Fatal("new event displaced the bounded recent snapshot", err)
	}
	latest := recent[len(recent)-1]
	if latest.At != iso(now) || latest.Event != "service.started" || latest.Role != "vm-worker" || latest.Version != "0.4.7-beta.23" {
		t.Fatal("newest persisted event was hidden by retained versions", latest)
	}
	if status := logger.Status(); status.FileCount != 9 || status.LastError != nil || status.DroppedRecords != 0 {
		t.Fatal("current writer did not retain its own healthy file", status)
	}
}
