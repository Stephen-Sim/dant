package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/telegram"
)

func TestInitialConnectionReservationFinishesBeforeTelegramBacklogPolling(t *testing.T) {
	options := fixtureWorkerOptions(t)
	entered, release := make(chan struct{}), make(chan struct{})
	options.WorkerOptions.VerifyRuntime = func(ctx context.Context) error {
		close(entered)
		select {
		case <-release:
			return errors.New("isolated initial executor unavailable")
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	var polls atomic.Int32
	pollingStarted := make(chan struct{})
	var started sync.Once
	options.TelegramHTTP = appHTTPFunc(func(request *http.Request) (*http.Response, error) {
		var result string
		switch {
		case strings.HasSuffix(request.URL.Path, "/getMe"):
			started.Do(func() { close(pollingStarted) })
			select {
			case <-entered:
			case <-request.Context().Done():
				return nil, request.Context().Err()
			}
			result = `{"ok":true,"result":{"id":11,"is_bot":true,"username":"fixture_bot"}}`
		case strings.HasSuffix(request.URL.Path, "/getWebhookInfo"):
			result = `{"ok":true,"result":{"url":""}}`
		case strings.HasSuffix(request.URL.Path, "/getUpdates"):
			if polls.Add(1) != 1 {
				<-request.Context().Done()
				return nil, request.Context().Err()
			}
			result = `{"ok":true,"result":[{"update_id":100,"message":{"message_id":99,"text":"isolated startup backlog","chat":{"id":21,"type":"private"},"from":{"id":31,"is_bot":false}}}]}`
		default:
			return nil, errors.New("isolated Telegram delivery is forbidden")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(result)), Header: http.Header{}}, nil
	})
	writeStartupTelegramConfiguration(t, options)
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	changes, unsubscribe := app.engine.Subscribe()
	defer unsubscribe()
	app.Start()
	app.Start()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("initial connection did not reserve admission")
	}
	select {
	case <-pollingStarted:
		close(release)
		t.Fatal("Telegram backlog was polled during the initial connection maintenance reservation")
	case <-time.After(250 * time.Millisecond):
	}
	close(release)
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	for {
		state := app.store.Snapshot()
		if len(state.Messages) == 1 && state.Messages[0].Status.Value == contracts.MessageStatus(contracts.TaskStatusQueued) {
			if state.Messages[0].Text != "isolated startup backlog" || state.Messages[0].Error.Present || polls.Load() < 1 {
				t.Fatal("startup backlog content or known admission status changed")
			}
			return
		}
		select {
		case <-changes:
		case <-deadline.C:
			t.Fatal("backlog did not enter the queue after the one initial connection attempt settled")
		}
	}
}

func writeStartupTelegramConfiguration(t *testing.T, options WorkerOptions) {
	t.Helper()
	token := "123456:" + strings.Repeat("a", 30)
	configuration := telegram.Config{Version: 1, DeliveryVersion: 2, ForwardMode: telegram.ForwardUnread, CombineReplies: true,
		Enabled: true, Token: &token, Bot: &telegram.Bot{ID: "11", Username: "fixture_bot"},
		Owner:  &telegram.Owner{ChatID: "21", UserID: "31", PairingID: "isolated-pairing", SyncVersion: 1},
		Outbox: []*telegram.OutboxItem{}, Receipts: []telegram.Receipt{}, ResultKeys: []string{}}
	data, err := json.Marshal(configuration)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(options.Startup.DataDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(options.Startup.DataDir, "telegram.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestClosingDuringInitialConnectionPreventsLateTelegramPolling(t *testing.T) {
	options := fixtureWorkerOptions(t)
	entered := make(chan struct{})
	var attempts, requests atomic.Int32
	options.WorkerOptions.VerifyRuntime = func(ctx context.Context) error {
		attempts.Add(1)
		close(entered)
		<-ctx.Done()
		return ctx.Err()
	}
	options.TelegramHTTP = appHTTPFunc(func(*http.Request) (*http.Response, error) {
		requests.Add(1)
		return nil, errors.New("late polling must not run")
	})
	writeStartupTelegramConfiguration(t, options)
	app, err := NewWorker(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	app.Start()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("initial connection did not start")
	}
	app.Close()
	app.Start()
	if attempts.Load() != 1 || requests.Load() != 0 || app.engine.MaintenanceActive() {
		t.Fatal("shutdown replayed connection or started late polling")
	}
	records, err := app.diagnostics.Recent(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	started, cancelled := false, false
	for _, record := range records {
		started = started || record.Event == "service.started" && record.Source == options.Source && record.Version == options.Version
		cancelled = cancelled || record.Event == "worker.connection" && record.Code == "WORKER_CONNECTION_CANCELLED"
	}
	if !started || !cancelled {
		t.Fatal("startup or cancellation provenance was not recorded")
	}
}
