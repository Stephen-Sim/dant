package app

import (
	"context"
	"errors"

	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

const (
	telegramAdmissionTimeoutCode           = "TELEGRAM_ADMISSION_TIMEOUT"
	telegramAdmissionCancelledCode         = "TELEGRAM_ADMISSION_CANCELLED"
	telegramExecutorUnavailableCode        = "TELEGRAM_EXECUTOR_UNAVAILABLE"
	telegramOwnerChangedCode               = "TELEGRAM_OWNER_CHANGED"
	telegramExecutionUnconfirmedCode       = "TELEGRAM_EXECUTION_UNCONFIRMED"
	telegramExecutorQueueLimitCode         = "TELEGRAM_EXECUTOR_QUEUE_LIMIT"
	telegramAdmissionPersistenceFailedCode = "TELEGRAM_ADMISSION_PERSISTENCE_FAILED"
	telegramAdmissionUnclassifiedCode      = "TELEGRAM_ADMISSION_UNCLASSIFIED"
)

func telegramAdmissionCode(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, workerRuntime.ErrRequestTimeout):
		return telegramAdmissionTimeoutCode
	case errors.Is(err, context.Canceled):
		return telegramAdmissionCancelledCode
	case errors.Is(err, work.ErrClosed), errors.Is(err, workerRuntime.ErrDisconnected):
		return telegramExecutorUnavailableCode
	case errors.Is(err, work.ErrStaleOwner):
		return telegramOwnerChangedCode
	case errors.Is(err, work.ErrUnknown):
		return telegramExecutionUnconfirmedCode
	case errors.Is(err, workerRuntime.ErrBackpressure):
		return telegramExecutorQueueLimitCode
	case errors.Is(err, store.ErrPersistence), errors.Is(err, store.ErrClosed):
		return telegramAdmissionPersistenceFailedCode
	default:
		return telegramAdmissionUnclassifiedCode
	}
}

func (app *WorkerApp) reportTelegramAdmission(err error) {
	if code := telegramAdmissionCode(err); code != "" && app.diagnostics != nil {
		app.diagnostics.Log("telegram.admission.failed", diagnostics.Fields{Code: code})
	}
}
