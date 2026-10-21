package controller

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
	"github.com/Stephen-Sim/dant/core/internal/security"
)

const pendingSessionMaxBytes = 8192

type connectionOptions struct {
	RecoverExecutor bool
	Deploy          bool
	RecoverPending  bool
}

// This path cannot clear an upgrade fence or resend its installer. It binds a
// fresh authenticated API observation to the compatible Worker just inspected
// over SSH, then leaves executor stop/admission proof to that Worker's API.
func (app *App) recoverPendingConnection(ctx context.Context, cause error) (func() error, error) {
	var pending *computer.PendingDeploymentError
	if !errors.As(cause, &pending) {
		return nil, cause
	}
	binding, err := computer.ReadBinding(app.options.DataDir)
	if err != nil || computer.BindingDigest(binding) != pending.BindingDigest {
		return nil, computer.ErrBridgeChanged
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if app.bridge.Status() != contracts.ConnectionStatusOnline {
		if err := app.bridge.Connect(ctx, false); err != nil {
			return nil, err
		}
	}

	generation := app.bridge.Generation()
	identity := app.bindingIdentity()
	current := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		app.mu.Lock()
		closed := app.closed
		app.mu.Unlock()
		latest, err := computer.ReadBinding(app.options.DataDir)
		if err != nil || computer.BindingDigest(latest) != pending.BindingDigest ||
			app.bindingIdentity() != identity || app.bridge.Generation() != generation ||
			app.bridge.Status() != contracts.ConnectionStatusOnline || closed {
			return computer.ErrBridgeChanged
		}
		return nil
	}
	if err := current(); err != nil {
		return nil, err
	}
	response, err := app.bridge.Request(ctx, http.MethodGet, "/api/session", nil, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, pendingSessionMaxBytes+1))
	if err != nil || response.StatusCode != http.StatusOK || len(raw) > pendingSessionMaxBytes {
		return nil, computer.ErrSessionUnavailable
	}
	if _, err := contracts.DecodeObject(raw, pendingSessionMaxBytes); err != nil {
		return nil, computer.ErrSessionUnavailable
	}
	var session struct {
		Product  string `json:"product"`
		Mode     string `json:"mode"`
		Runtime  string `json:"runtime"`
		Protocol int    `json:"protocol"`
		Version  string `json:"version"`
		Source   string `json:"source"`
	}
	if json.Unmarshal(raw, &session) != nil || session.Product != "dant" || session.Mode != "worker" ||
		session.Runtime != security.CoreRuntime || session.Protocol != security.CoreProtocolVersion ||
		session.Version != pending.Version || session.Source != pending.Source {
		return nil, computer.ErrSessionUnavailable
	}
	if err := current(); err != nil {
		return nil, err
	}
	if app.diagnostics != nil {
		app.diagnostics.Log("computer.update.unconfirmed", diagnostics.Fields{
			Code:   codeVMUpdateUnconfirmed,
			Method: http.MethodPost,
			Route:  computerConnectRoute,
		})
	}
	return current, nil
}
