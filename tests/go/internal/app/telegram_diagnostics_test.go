package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestTelegramAdmissionDiagnosticsClassifyWrappedCausesWithoutRawErrors(t *testing.T) {
	for _, test := range []struct {
		err  error
		code string
	}{
		{context.Canceled, "TELEGRAM_ADMISSION_CANCELLED"},
		{context.DeadlineExceeded, "TELEGRAM_ADMISSION_TIMEOUT"},
		{workerRuntime.ErrRequestTimeout, "TELEGRAM_ADMISSION_TIMEOUT"},
		{work.ErrClosed, "TELEGRAM_EXECUTOR_UNAVAILABLE"},
		{workerRuntime.ErrDisconnected, "TELEGRAM_EXECUTOR_UNAVAILABLE"},
		{work.ErrStaleOwner, "TELEGRAM_OWNER_CHANGED"},
		{work.ErrUnknown, "TELEGRAM_EXECUTION_UNCONFIRMED"},
		{workerRuntime.ErrBackpressure, "TELEGRAM_EXECUTOR_QUEUE_LIMIT"},
		{store.ErrPersistence, "TELEGRAM_ADMISSION_PERSISTENCE_FAILED"},
		{store.ErrClosed, "TELEGRAM_ADMISSION_PERSISTENCE_FAILED"},
		{errors.New("synthetic private failure"), "TELEGRAM_ADMISSION_UNCLASSIFIED"},
	} {
		if got := telegramAdmissionCode(fmt.Errorf("private envelope: %w", test.err)); got != test.code {
			t.Fatal("bounded admission classification changed", got)
		}
	}
	if telegramAdmissionCode(nil) != "" {
		t.Fatal("successful admission created a failure record")
	}
	app := fixtureWorker(t)
	err := app.admitTelegram(t.Context(), "replaced-conversation", &contracts.ChatMessage{
		Role: contracts.RoleUser, ClientMessageID: "tg:synthetic:1", Source: contracts.RawObject{"type": encode("telegram")},
	})
	if !errors.Is(err, work.ErrStaleOwner) {
		t.Fatal("diagnostics changed the original admission outcome", err)
	}
	app.Close()
	records, err := app.diagnostics.Recent(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, record := range records {
		if record.Event == "telegram.admission.failed" && record.Code == "TELEGRAM_OWNER_CHANGED" {
			found = true
		}
	}
	if !found || strings.Contains(string(encode(records)), "replaced-conversation") || len(app.store.Snapshot().Messages) != 0 {
		t.Fatal("admission diagnostics lost the cause or included request identity/content")
	}
}
