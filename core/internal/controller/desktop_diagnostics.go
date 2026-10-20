package controller

import (
	"net/http"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
)

const (
	desktopExitRoute       = "/api/desktop/exit"
	desktopCancelExitRoute = "/api/desktop/cancel-exit"
	desktopOpenRoute       = "/api/desktop/open"
)

// The coordinator consumes only bounded operational logging, not a concrete
// logger's persistence or shutdown capabilities.
type DesktopDiagnostics interface {
	Log(string, diagnostics.Fields) bool
}

func desktopDiagnosticCode(code string) string {
	switch code {
	case codeRequestFailed, codeInvalidRequest, codeDesktopBusy, codeBackupRunning,
		codeRestoreUnconfirmed, codeBackupBeforeChange, codeVMOffline,
		codePauseUnconfirmed, codeRequestCancelled, codeRequestTimeout:
		return code
	}
	for _, reason := range []computer.LifecycleReason{
		computer.LifecycleReasonBusy, computer.LifecycleReasonInvalidIdentity,
		computer.LifecycleReasonInvalidReceipt, computer.LifecycleReasonBindingChanged,
		computer.LifecycleReasonIntentChanged, computer.LifecycleReasonUnconfirmed,
		computer.LifecycleReasonUnsupported,
	} {
		if code == (&computer.LifecycleError{Reason: reason}).Code() {
			return code
		}
	}
	return codeRequestFailed
}

func desktopFailureFields(err error) diagnostics.Fields {
	failure := classifyHTTPError(err)
	return diagnostics.Fields{
		Code:   desktopDiagnosticCode(failure.body.Code),
		Phase:  string(failure.body.Phase),
		Method: "POST",
		Route:  desktopExitRoute,
	}
}

func (app *App) writeRequestError(writer http.ResponseWriter, request *http.Request, err error) {
	if app.diagnostics != nil {
		switch request.URL.Path {
		case desktopExitRoute, desktopCancelExitRoute, desktopOpenRoute:
			fields := desktopFailureFields(err)
			fields.Method = request.Method
			fields.Route = request.URL.Path
			app.diagnostics.Log("desktop.request.failed", fields)
		}
	}

	writeError(writer, err)
}

func (desktop *DesktopLifecycle) logExit(event string, phase contracts.DesktopPhase, code string) {
	if desktop.options.Diagnostics == nil {
		return
	}
	fields := diagnostics.Fields{Route: desktopExitRoute, Method: "POST", Code: code}
	if phase.Valid() {
		fields.Phase = string(phase)
	}
	desktop.options.Diagnostics.Log(event, fields)
}
