package controller

import (
	"context"
	"errors"
	"net/http"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/settings"
	"github.com/Stephen-Sim/dant/core/internal/updates"
)

const (
	codeRequestFailed          = "request_failed"
	codeInvalidRequest         = "invalid_request"
	codeDesktopBusy            = "desktop_transition_busy"
	codeBackupRunning          = "backup_running"
	codeRestoreUnconfirmed     = "backup_restore_unconfirmed"
	codeBackupBeforeChange     = "backup_before_vm_change_required"
	codeVMOffline              = "vm_offline"
	codePauseUnconfirmed       = "vm_pause_unconfirmed"
	codeRequestCancelled       = "request_cancelled"
	codeRequestTimeout         = "request_timeout"
	codeDesktopWorkPaused      = "desktop_work_paused"
	codeDesktopSuspendStarted  = "desktop_suspend_requested"
	codeDesktopExitStarted     = "desktop_exit_started"
	codeDesktopExitConfirmed   = "desktop_exit_confirmed"
	codeDesktopExitUnsupported = "desktop_exit_vm_unsupported"
)

type desktopPhaseError struct {
	phase contracts.DesktopPhase
	cause error
}

func (err *desktopPhaseError) Error() string {
	return "desktop_transition_failed"
}

func (err *desktopPhaseError) Unwrap() error {
	return err.cause
}

type errorBody struct {
	Error string                 `json:"error"`
	Code  string                 `json:"code"`
	Phase contracts.DesktopPhase `json:"phase,omitempty"`
}

type httpFailure struct {
	status int
	body   errorBody
}

func classifyHTTPError(err error) httpFailure {
	failure := httpFailure{
		status: http.StatusBadGateway,
		body: errorBody{
			Code:  codeRequestFailed,
			Error: "The request could not be completed. Check the connection and its current state.",
		},
	}
	var api *contracts.APIError
	var update *updates.Error
	var lifecycle *computer.LifecycleError
	switch {
	case errors.As(err, &api):
		failure.status, failure.body.Code, failure.body.Error = api.Status, api.Code, api.Message
	case errors.As(err, &update):
		failure.status, failure.body.Code, failure.body.Error = update.Status, update.Code, update.Message
	case errors.As(err, &lifecycle):
		failure.status = http.StatusConflict
		failure.body.Code = lifecycle.Code()
		failure.body.Error = "The VM operation could not be confirmed. Check Work computer and any administrator prompt before trying again."
		if lifecycle.Reason == computer.LifecycleReasonInvalidTimeout {
			failure.status, failure.body.Code = http.StatusBadRequest, codeInvalidRequest
			failure.body.Error = "Check the request values and try again."
		}
	default:
		switch {
		case errors.Is(err, computer.ErrBinding), errors.Is(err, backups.ErrInvalid), errors.Is(err, security.ErrAPIKey), errors.Is(err, settings.ErrInvalidAppearance):
			failure.status, failure.body.Code, failure.body.Error = 400, codeInvalidRequest, "Check the request values and try again."
		case errors.Is(err, ErrDesktopBusy), errors.Is(err, computer.ErrBridgeBusy), errors.Is(err, updates.ErrInstallationDeferred):
			failure.status, failure.body.Code, failure.body.Error = 409, codeDesktopBusy, "Work is paused for an update or exit."
		case errors.Is(err, computer.ErrPauseUnconfirmed):
			failure.status, failure.body.Code, failure.body.Error = 409, codePauseUnconfirmed, "Work pause could not be confirmed. Check Work computer before trying Exit again."
		case errors.Is(err, backups.ErrBusy), errors.Is(err, backups.ErrRunning):
			failure.status, failure.body.Code, failure.body.Error = 409, codeBackupRunning, "A backup operation is already running."
		case errors.Is(err, backups.ErrRestoreUnconfirmed):
			failure.status, failure.body.Code, failure.body.Error = 409, codeRestoreUnconfirmed, "The restore outcome is not confirmed. Check its status before continuing."
		case errors.Is(err, backups.ErrBeforeVMChange):
			failure.status, failure.body.Code, failure.body.Error = 409, codeBackupBeforeChange, "A backup is required before changing this computer."
		case errors.Is(err, computer.ErrBridgeOffline):
			failure.status, failure.body.Code, failure.body.Error = 503, codeVMOffline, "The work computer is offline. Reconnect before continuing."
		case errors.Is(err, context.Canceled):
			failure.status, failure.body.Code, failure.body.Error = 499, codeRequestCancelled, "The request was cancelled."
		case errors.Is(err, context.DeadlineExceeded):
			failure.status, failure.body.Code, failure.body.Error = 504, codeRequestTimeout, "The request timed out. Check its current state before trying again."
		}
	}
	var phase *desktopPhaseError
	if errors.As(err, &phase) && phase.phase.Valid() {
		failure.body.Phase = phase.phase
	}
	return failure
}
