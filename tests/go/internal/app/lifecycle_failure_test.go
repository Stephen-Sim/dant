package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/ownership"
	"github.com/Stephen-Sim/dant/core/internal/voice"
)

func TestWorkerStartupFailuresPreserveEvidenceAndReleaseOnlyTheirOwnLock(t *testing.T) {
	for _, scenario := range []string{"version", "cancelled", "state", "memory", "attachments", "workspace", "transcriber-home", "schedules", "telegram", "session-port"} {
		t.Run(scenario, func(t *testing.T) {
			options := fixtureWorkerOptions(t)
			ctx := t.Context()
			if err := os.MkdirAll(options.Startup.DataDir, 0o700); err != nil {
				t.Fatal(err)
			}
			write := func(name, content string) {
				t.Helper()
				path := filepath.Join(options.Startup.DataDir, filepath.FromSlash(name))
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			switch scenario {
			case "version":
				options.Version = ""
			case "cancelled":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			case "state":
				write("state.json", "{invalid preserved original")
			case "memory":
				write("memory/dant/memory.sqlite", "not a database; must be preserved")
			case "attachments":
				write("attachments", "preserved non-directory fixture")
			case "workspace":
				options.Startup.WorkspaceRoot = filepath.Join(t.TempDir(), "workspace-file")
				if err := os.WriteFile(options.Startup.WorkspaceRoot, []byte("preserved"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "transcriber-home":
				options.Startup.Home = "relative-home"
			case "schedules":
				write("schedules/schedules.sqlite", "preserved invalid database")
			case "telegram":
				write("telegram.json", "{invalid preserved config")
			case "session-port":
				options.Startup.Listen.Port = 0
			}
			app, err := NewWorker(ctx, options)
			if err == nil {
				app.Close()
				t.Fatalf("unsafe startup fixture unexpectedly assembled: %s", scenario)
			}
			if scenario == "state" {
				data, readErr := os.ReadFile(filepath.Join(options.Startup.DataDir, "state.json"))
				if readErr != nil || string(data) != "{invalid preserved original" {
					t.Fatal("failed startup overwrote malformed authority")
				}
			}
			lock, lockErr := ownership.Acquire(t.Context(), options.Startup.DataDir)
			if lockErr != nil {
				t.Fatal("failed startup leaked ownership", lockErr)
			}
			_ = lock.Close()
		})
	}
}

func TestWorkerStartOnceConnectFailurePublishesOnlySanitizedNoticeAndJoinsShutdown(t *testing.T) {
	options := fixtureWorkerOptions(t)
	var attempts atomic.Int32
	options.WorkerOptions.VerifyRuntime = func(context.Context) error {
		attempts.Add(1)
		return errors.New("synthetic_private_runtime_failure")
	}
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	client, accepted := app.events.subscribe(t.Context())
	if !accepted {
		t.Fatal("event observer unavailable")
	}
	if app.canSchedule() {
		t.Fatal("offline Worker admitted a heartbeat")
	}
	app.Start()
	app.Start()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	select {
	case raw := <-client.control:
		if strings.Contains(string(raw), "synthetic_private_runtime_failure") || !strings.Contains(string(raw), "could not connect") {
			t.Fatal("startup notice exposed a raw error or claimed success")
		}
	case <-deadline.C:
		t.Fatal("connection failure notice did not arrive")
	}
	app.Close()
	if attempts.Load() != 1 || client.ctx.Err() == nil {
		t.Fatal("startup was replayed or shutdown retained its observer")
	}
}

func TestWorkerStartPreservesUnknownStopWithoutStartingReplacementExecutor(t *testing.T) {
	options := fixtureWorkerOptions(t)
	var attempts atomic.Int32
	options.WorkerOptions.VerifyRuntime = func(context.Context) error {
		attempts.Add(1)
		return errors.New("must never be called")
	}
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	if err := app.engine.FenceUnconfirmedStop(t.Context()); err != nil {
		t.Fatal(err)
	}
	client, _ := app.events.subscribe(t.Context())
	app.Start()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	select {
	case raw := <-client.control:
		if !strings.Contains(string(raw), "stop could not be confirmed") {
			t.Fatal("unknown executor stop lost its reconciliation warning")
		}
	case <-deadline.C:
		t.Fatal("unknown-stop notice did not arrive")
	}
	app.Close()
	if attempts.Load() != 0 {
		t.Fatal("unknown stop started a replacement runtime")
	}
}

func TestWorkerSnapshotAndReadOnlyEndpointsFailClosedWhenMemoryAuthorityCloses(t *testing.T) {
	app := fixtureWorker(t)
	if err := app.memory.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := app.Snapshot(t.Context()); err == nil {
		t.Fatal("closed memory authority was presented as a valid state")
	}
	response := callWorker(app, http.MethodGet, "/api/state", "")
	if response.Code < 400 {
		t.Fatal("failed snapshot was reported successful")
	}
	if _, err := app.saveNote(t.Context(), "working-memory.md", "must not be reported saved"); err == nil {
		t.Fatal("closed memory store accepted a note")
	}
	if app.callInputCurrent(app.store.ConversationID(), "old-call", "missing") {
		t.Fatal("offline call input became current")
	}
	(&WorkerApp{}).caption(voice.Caption{})
	if (&WorkerApp{}).redactContext(t.Context(), "private fixture") != "" {
		t.Fatal("missing redactor exposed text")
	}
	if string(encode(make(chan int))) != "null" {
		t.Fatal("unsupported JSON value did not become a safe null")
	}
}
