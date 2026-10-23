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

const recoverySessionMaxBytes = 8192

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
	current, err := app.recoverySessionCurrent(ctx, pending.BindingDigest, pending.Version, pending.Source)
	if err != nil {
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

func (app *App) recoverCurrentConnection(ctx context.Context) (func() error, error) {
	binding, err := computer.ReadBinding(app.options.DataDir)
	if err != nil {
		return nil, err
	}
	return app.recoverySessionCurrent(ctx, computer.BindingDigest(binding), app.options.Version, app.options.BuildSource)
}

// Re-read the authenticated session before and after executor recovery. A live
// tunnel alone does not prove the same Worker still owns this connection.
func (app *App) recoverySessionCurrent(ctx context.Context, digest, version, source string) (func() error, error) {
	generation := app.bridge.Generation()
	identity := app.bindingIdentity()
	localCurrent := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		app.mu.Lock()
		closed := app.closed
		app.mu.Unlock()
		latest, err := computer.ReadBinding(app.options.DataDir)
		if err != nil || computer.BindingDigest(latest) != digest ||
			app.bindingIdentity() != identity || app.bridge.Generation() != generation ||
			app.bridge.Status() != contracts.ConnectionStatusOnline || closed {
			return computer.ErrBridgeChanged
		}
		return nil
	}
	current := func() error {
		if err := localCurrent(); err != nil {
			return err
		}
		response, err := app.bridge.Request(ctx, http.MethodGet, "/api/session", nil, nil)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(response.Body, recoverySessionMaxBytes+1))
		if err != nil || response.StatusCode != http.StatusOK || len(raw) > recoverySessionMaxBytes {
			return computer.ErrSessionUnavailable
		}
		if _, err := contracts.DecodeObject(raw, recoverySessionMaxBytes); err != nil {
			return computer.ErrSessionUnavailable
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
			session.Version != version || session.Source != source {
			return computer.ErrSessionUnavailable
		}
		return localCurrent()
	}
	if err := current(); err != nil {
		return nil, err
	}
	return current, nil
}
