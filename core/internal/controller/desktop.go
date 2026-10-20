// Package controller owns local host orchestration. It never constructs an Engine.
package controller

import (
	"context"
	"errors"
	"sync"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

var ErrDesktopBusy = errors.New("desktop_transition_busy")

type DesktopBridge interface {
	Status() contracts.ConnectionStatus
	Snapshot() contracts.WorkerSnapshot
	Connect(context.Context, bool) error
	Refresh(context.Context) (contracts.WorkerSnapshot, error)
	PauseWorkForUpdate(context.Context, string) error
	Disconnect()
}

type OwnedVMLifecycle interface {
	Suspend(context.Context) (computer.SuspendResult, error)
	Resume(context.Context) (computer.ResumeResult, error)
	ResumeForReconnect(context.Context) (computer.ResumeResult, error)
}

type DesktopOptions struct {
	Bridge      DesktopBridge
	Lifecycle   OwnedVMLifecycle
	Binding     func() string
	Configured  func() bool
	Changed     func()
	Diagnostics DesktopDiagnostics
}

type DesktopLifecycle struct {
	mu      sync.Mutex
	options DesktopOptions
	phase   contracts.DesktopPhase
	pending bool
	closed  bool
}

type DesktopResult struct {
	OK            bool  `json:"ok"`
	WorkPaused    bool  `json:"workPaused,omitempty"`
	VMSuspended   *bool `json:"vmSuspended,omitempty"`
	Unsupported   bool  `json:"unsupported,omitempty"`
	NotConfigured bool  `json:"notConfigured,omitempty"`
}

type PrepareOptions struct {
	RecoverManagedVM         bool
	ManagedVMAlreadyRestored bool
}

func NewDesktopLifecycle(options DesktopOptions) *DesktopLifecycle {
	if options.Changed == nil {
		options.Changed = func() {}
	}

	return &DesktopLifecycle{options: options, phase: contracts.DesktopPhaseIdle}
}

func (desktop *DesktopLifecycle) Phase() contracts.DesktopPhase {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	return desktop.phase
}

func (desktop *DesktopLifecycle) Blocked() bool { return desktop.Phase() != contracts.DesktopPhaseIdle }
func (desktop *DesktopLifecycle) SetPhase(phase contracts.DesktopPhase) error {
	if !phase.Valid() {
		return ErrDesktopBusy
	}
	desktop.mu.Lock()
	if desktop.closed {
		desktop.mu.Unlock()
		return ErrDesktopBusy
	}
	desktop.phase = phase
	desktop.mu.Unlock()
	desktop.options.Changed()
	return nil
}

func (desktop *DesktopLifecycle) run(ctx context.Context, operation func(func() error) (DesktopResult, error)) (DesktopResult, error) {
	desktop.mu.Lock()
	if desktop.closed || desktop.pending {
		desktop.mu.Unlock()
		return DesktopResult{}, ErrDesktopBusy
	}
	desktop.pending = true
	desktop.mu.Unlock()
	identity := desktop.options.Binding()
	current := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		desktop.mu.Lock()
		closed := desktop.closed
		desktop.mu.Unlock()
		if closed || desktop.options.Binding() != identity {
			return ErrDesktopBusy
		}
		return nil
	}
	result, err := operation(current)
	desktop.mu.Lock()
	desktop.pending = false
	if err != nil && !desktop.closed {
		desktop.phase = contracts.DesktopPhaseIdle
	}
	desktop.mu.Unlock()
	if err != nil {
		desktop.options.Changed()
	}

	return result, err
}

func (desktop *DesktopLifecycle) pause(ctx context.Context, current func() error, reason string) error {
	if desktop.Phase() == contracts.DesktopPhasePaused && desktop.options.Configured() {
		state, err := desktop.options.Bridge.Refresh(ctx)
		if err != nil {
			return err
		}
		if err := current(); err != nil {
			return err
		}
		if !computer.ServiceUpdateQuiescent(state, true) {
			return ErrDesktopBusy
		}
		return nil
	}

	if err := desktop.SetPhase(contracts.DesktopPhasePausing); err != nil {
		return err
	}

	if err := current(); err != nil {
		return err
	}

	if !desktop.options.Configured() {
		return desktop.SetPhase(contracts.DesktopPhasePaused)
	}

	if desktop.options.Bridge.Status() != contracts.ConnectionStatusOnline {
		if err := desktop.options.Bridge.Connect(ctx, false); err != nil {
			return err
		}
	}

	if err := current(); err != nil {
		return err
	}
	worker := desktop.options.Bridge.Snapshot().Worker.Status
	if worker == contracts.ConnectionStatusOffline || worker == contracts.ConnectionStatusConnecting {
		state, err := desktop.options.Bridge.Refresh(ctx)
		if err != nil {
			return err
		}
		if err := current(); err != nil {
			return err
		}
		if !computer.ServiceUpdateQuiescent(state, true) {
			return ErrDesktopBusy
		}
		return desktop.SetPhase(contracts.DesktopPhasePaused)
	}

	if err := desktop.options.Bridge.PauseWorkForUpdate(ctx, reason); err != nil {
		return err
	}

	if err := current(); err != nil {
		return err
	}

	return desktop.SetPhase(contracts.DesktopPhasePaused)
}

func (desktop *DesktopLifecycle) Prepare(ctx context.Context, options PrepareOptions) (DesktopResult, error) {
	return desktop.run(ctx, func(current func() error) (DesktopResult, error) {
		if desktop.options.Configured() && desktop.options.Bridge.Status() != contracts.ConnectionStatusOnline {
			if err := desktop.SetPhase(contracts.DesktopPhaseResuming); err != nil {
				return DesktopResult{}, err
			}
			if !options.ManagedVMAlreadyRestored {
				var err error
				if options.RecoverManagedVM {
					_, err = desktop.options.Lifecycle.ResumeForReconnect(ctx)
				} else {
					_, err = desktop.options.Lifecycle.Resume(ctx)
				}
				if err != nil {
					return DesktopResult{}, err
				}
			}
			if err := current(); err != nil {
				return DesktopResult{}, err
			}
		}
		if err := desktop.pause(ctx, current, "install"); err != nil {
			return DesktopResult{}, err
		}
		return DesktopResult{OK: true, WorkPaused: true}, nil
	})
}

func (desktop *DesktopLifecycle) Exit(ctx context.Context) (DesktopResult, error) {
	var phase contracts.DesktopPhase
	result, err := desktop.run(ctx, func(current func() error) (DesktopResult, error) {
		phase = contracts.DesktopPhasePausing
		desktop.logExit("desktop.exit.stage", phase, codeDesktopExitStarted)
		if err := desktop.pause(ctx, current, "exit"); err != nil {
			return DesktopResult{}, err
		}
		desktop.logExit("desktop.exit.stage", contracts.DesktopPhasePaused, codeDesktopWorkPaused)
		phase = contracts.DesktopPhaseSuspending
		if err := desktop.SetPhase(contracts.DesktopPhaseSuspending); err != nil {
			return DesktopResult{}, err
		}
		desktop.logExit("desktop.exit.stage", phase, codeDesktopSuspendStarted)
		result, err := desktop.options.Lifecycle.Suspend(ctx)
		if err != nil {
			return DesktopResult{}, err
		}
		if err := current(); err != nil {
			return DesktopResult{}, err
		}
		completedPhase := contracts.DesktopPhasePaused
		if result.VMSuspended {
			completedPhase = contracts.DesktopPhaseSuspended
			desktop.options.Bridge.Disconnect()
		}
		if err := desktop.SetPhase(completedPhase); err != nil {
			return DesktopResult{}, err
		}
		code := codeDesktopExitConfirmed
		if !result.VMSuspended {
			code = codeDesktopExitUnsupported
		}
		desktop.logExit("desktop.exit.confirmed", completedPhase, code)
		return DesktopResult{OK: true, WorkPaused: true, VMSuspended: &result.VMSuspended, Unsupported: !result.VMSuspended, NotConfigured: !desktop.options.Configured()}, nil
	})
	if err == nil {
		return result, nil
	}
	if phase.Valid() {
		err = &desktopPhaseError{phase: phase, cause: err}
	}
	failure := classifyHTTPError(err)
	desktop.logExit("desktop.exit.failed", phase, desktopDiagnosticCode(failure.body.Code))
	return result, err
}

func (desktop *DesktopLifecycle) Cancel(ctx context.Context, managedVMAlreadyRestored bool) (DesktopResult, error) {
	return desktop.run(ctx, func(current func() error) (DesktopResult, error) {
		if err := desktop.SetPhase(contracts.DesktopPhaseResuming); err != nil {
			return DesktopResult{}, err
		}
		if !managedVMAlreadyRestored {
			if _, err := desktop.options.Lifecycle.Resume(ctx); err != nil {
				return DesktopResult{}, err
			}
		}
		if err := current(); err != nil {
			return DesktopResult{}, err
		}
		if desktop.options.Configured() && desktop.options.Bridge.Status() != contracts.ConnectionStatusOnline {
			if err := desktop.options.Bridge.Connect(ctx, false); err != nil {
				return DesktopResult{}, err
			}
		}
		if err := current(); err != nil {
			return DesktopResult{}, err
		}
		if err := desktop.SetPhase(contracts.DesktopPhaseIdle); err != nil {
			return DesktopResult{}, err
		}
		return DesktopResult{OK: true}, nil
	})
}

// Close only closes this coordinator; normal window/service shutdown never powers off a VM.
func (desktop *DesktopLifecycle) Close() {
	desktop.mu.Lock()
	desktop.closed = true
	desktop.mu.Unlock()
}
