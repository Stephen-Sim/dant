package backups

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkerBackupValidationDoesNotPauseOrRewriteState(t *testing.T) {
	raw := []byte(`{"conversationId":"49954ce5-c8c5-4f6e-a7d8-531530d09479","settings":{},"messages":[{"id":"user","role":"user","status":"running","text":"中文\ud83d","time":17}],"workTasks":[],"completions":[],"schedules":[]}`)
	archive, err := ValidateArchive(t.Context(), bytes.NewReader(fixtureArchive(raw)), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateWorkerBackup(t.Context(), archive); err != nil {
		t.Fatal(err)
	}
	current, err := os.ReadFile(filepath.Join(archive.Directory, "data", "state.json"))
	if err != nil || !bytes.Equal(current, raw) {
		t.Fatal("read-only cutover validation changed original status, text or timestamps")
	}
}

func TestWorkerBackupValidationRejectsMissingIdentityBeforeLiveWriters(t *testing.T) {
	for _, raw := range []string{
		`{"messages":[]}`,
		`{"conversationId":"49954ce5-c8c5-4f6e-a7d8-531530d09479","settings":{},"messages":[{"id":"x","role":"unknown"}],"workTasks":[],"completions":[]}`,
		`{"conversationId":"49954ce5-c8c5-4f6e-a7d8-531530d09479","settings":{},"messages":[],"workTasks":[],"completions":[],"schedules":[{"enabled":true}]}`,
	} {
		archive, err := ValidateArchive(t.Context(), bytes.NewReader(fixtureArchive([]byte(raw))), t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		if err := ValidateWorkerBackup(t.Context(), archive); err == nil {
			t.Fatal("invalid backup schema accepted")
		}
	}
}

func TestWorkerBackupValidationRejectsMalformedTelegramAndDatabase(t *testing.T) {
	for _, relative := range []string{"telegram.json", "memory/dant/memory.sqlite", "schedules/schedules.sqlite"} {
		t.Run(relative, func(t *testing.T) {
			archive, err := ValidateArchive(t.Context(), bytes.NewReader(fixtureArchive([]byte(`{"conversationId":"49954ce5-c8c5-4f6e-a7d8-531530d09479","settings":{},"messages":[],"workTasks":[],"completions":[]}`))), t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(archive.Directory, "data", filepath.FromSlash(relative))
			if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, []byte("malformed"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := ValidateWorkerBackup(t.Context(), archive); err == nil {
				t.Fatal("invalid feature schema accepted")
			}
		})
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := ValidateWorkerBackup(cancelled, ValidatedArchive{}); err != context.Canceled {
		t.Fatal("cancelled prevalidation continued")
	}
}
