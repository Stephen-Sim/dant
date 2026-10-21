package diagnostics

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func writeDiagnosticFixture(t *testing.T, dataDirectory, id string, created time.Time, contents string) string {
	t.Helper()
	directory := filepath.Join(dataDirectory, "logs")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(header{Schema: Schema, ID: id, CreatedAt: iso(created)})
	if err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(directory, "dant-diagnostics-v1-"+iso(created)[:10]+"-"+id+".jsonl")
	if err := os.WriteFile(name, append(append(encoded, '\n'), []byte(contents)...), 0o600); err != nil {
		t.Fatal(err)
	}
	return name
}

func TestDiagnosticInvalidStorageRemainsAvailableAsABoundedFailureStatus(t *testing.T) {
	if _, err := New(t.Context(), Options{DataDir: "relative"}); err == nil {
		t.Fatal("relative log directory was accepted")
	}
	for _, mode := range []string{"logs-file", "startup-directory", "linked-log"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			switch mode {
			case "logs-file":
				if err := os.WriteFile(filepath.Join(directory, "logs"), []byte("synthetic marker"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "startup-directory":
				if err := os.Mkdir(filepath.Join(directory, "startup.log"), 0o700); err != nil {
					t.Fatal(err)
				}
			case "linked-log":
				name := writeDiagnosticFixture(t, directory, "00000000-0000-4000-8000-000000000001", time.Now(), "")
				if err := os.Link(name, filepath.Join(directory, "other-link")); err != nil {
					t.Fatal(err)
				}
			}
			logger := newLogger(t, Options{DataDir: directory, Role: "invalid role", Version: "invalid", Now: func() time.Time { return time.Time{} }})
			if status := logger.Status(); status.LastError == nil || *status.LastError != "LOG_CLEANUP_FAILED" || status.Role != "service" || status.Version != nil {
				t.Fatal("invalid storage was silently accepted or leaked details")
			}
			logger.Log("synthetic.event", Fields{})
			logger.Close()
			status := logger.Status()
			if status.LastError == nil || *status.LastError != "LOG_WRITE_FAILED" || !status.Closed {
				t.Fatal("failed writer did not release its owner")
			}
			*status.LastError = "caller mutation"
			*status.LastErrorAt = 0
			if *logger.Status().LastError == "caller mutation" || *logger.Status().LastErrorAt == 0 {
				t.Fatal("caller mutated diagnostic failure status")
			}
		})
	}
}

func TestDiagnosticQueueDropsOnlyOverflowAndJoinsEveryAcceptedRecord(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		logger := newLogger(t, Options{DataDir: t.TempDir(), Role: "worker"})
		logger.fileGate <- struct{}{}
		if !logger.Log("synthetic.first", Fields{}) {
			t.Fatal("first diagnostic record was refused")
		}
		synctest.Wait()
		for index := 0; index < MaxQueue; index++ {
			if !logger.Log("synthetic.queued", Fields{}) {
				t.Fatal("bounded queue dropped a record before capacity")
			}
		}
		if logger.Log("synthetic.overflow", Fields{}) || logger.Status().DroppedRecords != 1 {
			t.Fatal("diagnostic overflow was not bounded and counted")
		}
		<-logger.fileGate
		if err := logger.Close(); err != nil || len(logger.queue) != 0 || logger.Status().LastError != nil {
			t.Fatal("closing diagnostics lost accepted records or retained a writer", err)
		}
	})
}

func TestDiagnosticPeriodicCleanupRetainsCurrentStartupMarkerAndDeletesExpiredOwnedLogs(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		directory := t.TempDir()
		now := time.Now()
		marker, err := json.Marshal(struct {
			Schema    string `json:"schema"`
			CreatedAt string `json:"createdAt"`
		}{StartupSchema, iso(now)})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "startup.log"), append(marker, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
		logger := newLogger(t, Options{DataDir: directory, Role: "controller", Version: "1.0.0"})
		defer logger.Close()
		expired := writeDiagnosticFixture(t, directory, "00000000-0000-4000-8000-000000000001", now.Add(-Retention), "")
		synctest.Wait()
		time.Sleep(CleanupInterval + time.Second)
		synctest.Wait()
		if _, err := os.Lstat(expired); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("periodic cleanup retained an expired owned log", err)
		}
		if raw, err := os.ReadFile(filepath.Join(directory, "startup.log")); err != nil || string(raw) != string(marker)+"\n" {
			t.Fatal("current startup marker was unnecessarily rewritten", err)
		}
		snapshot := logger.Status()
		*snapshot.Version = "caller mutation"
		if *logger.Status().Version != "1.0.0" {
			t.Fatal("status shared mutable version metadata")
		}
	})
}

func TestDiagnosticRecentSanitizesMalformedRecordsAndBoundsTailReads(t *testing.T) {
	directory := t.TempDir()
	now := time.Now()
	record := `{"event":"synthetic.event","at":"` + iso(now) + `","itemType":"plan","itemStatus":"completed","confirmed":false,"durationMs":1.25}` + "\n"
	invalid := "{}\nfalse\n" + `{"event":false,"at":"invalid"}` + "\n" + `{"event":"synthetic.invalid","at":"invalid"}` + "\n" + `{"event":"synthetic.old","at":"` + iso(now.Add(-Retention)) + `"}` + "\n"
	writeDiagnosticFixture(t, directory, "00000000-0000-4000-8000-000000000001", now, invalid+strings.Repeat(record, 2200))
	writeDiagnosticFixture(t, directory, "00000000-0000-4000-8000-000000000002", now, record)
	logger := newLogger(t, Options{DataDir: directory, Role: "worker"})
	logger.Close()
	if records, err := logger.Recent(t.Context(), 3); err != nil || len(records) != 3 || records[0].ItemType != "plan" || records[0].Confirmed == nil || *records[0].Confirmed {
		t.Fatal("bounded sanitized tail was not preserved", err)
	}
	if records, err := logger.Recent(t.Context(), 0); err != nil || len(records) != 0 {
		t.Fatal("zero limit read persisted records", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := logger.Recent(cancelled, 10); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled log read retained file ownership", err)
	}
	nonfinite := math.NaN()
	if logger.Log("synthetic.event", Fields{DurationMS: &nonfinite}) || logger.Status().LastError == nil || *logger.Status().LastError != "LOG_INVALID_METADATA" {
		t.Fatal("invalid numeric diagnostics were accepted")
	}
}

func TestDiagnosticQuotaCleanupCannotDeleteAReplacedRetainedFile(t *testing.T) {
	directory := t.TempDir()
	name := writeDiagnosticFixture(t, directory, "00000000-0000-4000-8000-000000000001", time.Now(), "")
	original, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	logger := newLogger(t, Options{DataDir: directory, Role: "worker", MaxFileBytes: 300, MaxTotalBytes: 300})
	retained := filepath.Join(directory, "retained-original")
	before, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(name, retained); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(name, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	if !logger.Log("synthetic.quota", Fields{Code: strings.Repeat("x", 60)}) {
		t.Fatal("synthetic quota record was not accepted")
	}
	logger.Close()
	status := logger.Status()
	if status.LastError == nil || *status.LastError != "LOG_WRITE_FAILED" {
		t.Fatal("retention accepted a replaced file identity")
	}
	for _, path := range []string{name, retained} {
		if data, err := os.ReadFile(path); err != nil || string(data) != string(original) {
			t.Fatal("quota cleanup removed an unconfirmed replacement or its retained original", err)
		}
	}
}
