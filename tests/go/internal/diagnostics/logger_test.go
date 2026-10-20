package diagnostics

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newLogger(t *testing.T, options Options) *Logger {
	t.Helper()
	logger, err := New(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = logger.Close() })
	return logger
}

func TestDiagnosticFieldsNeverPersistUserContentOrSecrets(t *testing.T) {
	logger := newLogger(t, Options{DataDir: t.TempDir(), Role: "worker", Version: "0.4.7-beta.12"})
	count := int64(0)
	if !logger.Log("http.request", Fields{
		Status: "online", Code: "request_finished", Count: &count,
		Method: "POST", Route: "/api/messages", ThreadID: "thread:sample",
		Reason: "Bearer:synthetic-secret-value", CallID: "sk-synthetic-secret-value",
	}) {
		t.Fatal("valid record refused")
	}
	if logger.Log("bad event with content", Fields{}) {
		t.Fatal("unbounded event accepted")
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}

	recent, err := logger.Recent(t.Context(), 50)
	if err != nil || len(recent) != 1 {
		t.Fatalf("recent: %+v %v", recent, err)
	}
	if recent[0].Status != "online" || recent[0].Reason != "" || recent[0].CallID != "" || recent[0].Count == nil || *recent[0].Count != 0 {
		t.Fatalf("unsafe fields retained or valid zero lost: %+v", recent[0])
	}
	entries, err := os.ReadDir(logger.Status().Directory)
	if err != nil || len(entries) != 1 {
		t.Fatalf("files: %+v %v", entries, err)
	}
	data, err := os.ReadFile(filepath.Join(logger.Status().Directory, entries[0].Name()))
	if err != nil || bytes.Contains(data, []byte("synthetic-secret-value")) || bytes.Contains(data, []byte("bad event")) {
		t.Fatal("unsafe content persisted")
	}
}

func TestDiagnosticsRotateBoundedLogsAndRetainOnlyThreeDays(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC).UnixMilli())
	now := func() time.Time { return time.UnixMilli(clock.Load()) }
	dataDir := t.TempDir()
	logger := newLogger(t, Options{DataDir: dataDir, Role: "worker", Now: now, MaxFileBytes: 600, MaxTotalBytes: 1200})
	for index := int64(0); index < 20; index++ {
		if !logger.Log("work.progress", Fields{Status: "running", Count: &index}) {
			t.Fatal("record unexpectedly refused")
		}
	}
	_ = logger.Close()
	status := logger.Status()
	if status.LastError != nil || status.TotalBytes > 1200 || status.FileCount < 1 {
		t.Fatalf("quota: %+v", status)
	}
	entries, err := os.ReadDir(status.Directory)
	if err != nil || len(entries) != status.FileCount {
		t.Fatalf("quota file count: %v", err)
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || info.Size() > 600 {
			t.Fatalf("file limit: %v", err)
		}
	}

	clock.Add(int64(Retention / time.Millisecond))
	current := newLogger(t, Options{DataDir: dataDir, Role: "worker", Now: now})
	_ = current.Close()
	entries, err = os.ReadDir(status.Directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("expired files retained: %v", err)
	}
}

func TestDiagnosticsAdoptStartupWithoutChangingInheritedFileIdentity(t *testing.T) {
	dataDir := t.TempDir()
	name := filepath.Join(dataDir, "startup.log")
	if err := os.WriteFile(name, []byte("unstructured synthetic previous output\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	// An inherited native stdout handle remains open while the service runs.
	writer, err := os.OpenFile(name, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	logger := newLogger(t, Options{DataDir: dataDir, Role: "controller"})
	_ = logger.Close()
	after, err := os.Stat(name)
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("startup handle identity replaced")
	}
	data, err := os.ReadFile(name)
	if err != nil || bytes.Contains(data, []byte("unstructured")) {
		t.Fatalf("unsafe startup data retained: %v", err)
	}
	var marker header
	if json.Unmarshal(bytes.TrimSpace(data), &marker) != nil || marker.Schema != StartupSchema {
		t.Fatal("startup schema marker missing")
	}
}

func TestDiagnosticRecentIsReadOnlyAndSanitizesDiskMetadata(t *testing.T) {
	logger := newLogger(t, Options{DataDir: t.TempDir(), Role: "worker"})
	logger.Log("service.started", Fields{})
	_ = logger.Close()
	directory := logger.Status().Directory
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 {
		t.Fatalf("log: %v", err)
	}
	name := filepath.Join(directory, entries[0].Name())
	file, err := os.OpenFile(name, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = file.WriteString(`{"at":"` + iso(time.Now()) + `","event":"old.record","status":"online","rawBody":"private content","reason":"Bearer:secret","route":"/api/messages/real-user-id?token=private"}` + "\n")
	_ = file.Close()
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	status := logger.Status()
	result, err := logger.Recent(t.Context(), 50)
	if err != nil || len(result) != 2 {
		t.Fatalf("recent: %+v %v", result, err)
	}
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), "private") || strings.Contains(string(encoded), "Bearer") {
		t.Fatal("legacy raw metadata exposed")
	}
	after, err := os.Stat(name)
	current := logger.Status()
	if err != nil || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) ||
		status.LastCleanupAt == nil || current.LastCleanupAt == nil || *status.LastCleanupAt != *current.LastCleanupAt {
		t.Fatal("read-only diagnostics mutated runtime data")
	}
}

func TestDiagnosticsConcurrentEnqueueAndCloseHaveBoundedOwnership(t *testing.T) {
	logger := newLogger(t, Options{DataDir: t.TempDir(), Role: "worker"})
	var workers sync.WaitGroup
	for index := 0; index < 8; index++ {
		workers.Go(func() {
			for count := int64(0); count < 50; count++ {
				logger.Log("work.progress", Fields{Count: &count})
			}
		})
	}
	workers.Wait()
	_ = logger.Close()
	_ = logger.Close()
	if logger.Log("after.close", Fields{}) || !logger.Status().Closed {
		t.Fatal("closed logger retained a writer")
	}
	if len(logger.queue) != 0 {
		t.Fatal("normal close did not drain accepted records")
	}
	if logger.Status().LastError != nil {
		t.Fatalf("writer failed: %+v", logger.Status())
	}
}

func TestDiagnosticsCancelledLifetimeJoinsWriter(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	logger, err := New(ctx, Options{DataDir: t.TempDir(), Role: "worker"})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
}
