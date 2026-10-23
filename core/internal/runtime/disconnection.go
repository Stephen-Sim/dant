package runtime

import (
	"errors"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

// DisconnectReason describes only the transport boundary, never provider output.
type DisconnectReason string

const (
	DisconnectUnknown        DisconnectReason = "unknown"
	DisconnectEOF            DisconnectReason = "eof"
	DisconnectReadError      DisconnectReason = "read-error"
	DisconnectFrameTooLarge  DisconnectReason = "frame-too-large"
	DisconnectProtocol       DisconnectReason = "protocol-invalid"
	DisconnectEventOverflow  DisconnectReason = "event-overflow"
	DisconnectWriteFailure   DisconnectReason = "write-failure"
	DisconnectContext        DisconnectReason = "context-cancelled"
	DisconnectExplicit       DisconnectReason = "explicit-close"
	DisconnectProcessExit    DisconnectReason = "process-exit"
	DisconnectRequestTimeout DisconnectReason = "request-timeout"
)

type ProcessExit struct {
	Observed      bool
	Code          int
	Signal        int
	StopRequested bool
}

type DisconnectInfo struct {
	Generation     uint64
	Reason         DisconnectReason
	ProcessStopped bool
	Exit           ProcessExit
}

func disconnectReason(cause error) DisconnectReason {
	switch {
	case errors.Is(cause, ErrInvalidProtocol):
		return DisconnectProtocol
	case errors.Is(cause, ErrBackpressure):
		return DisconnectEventOverflow
	case errors.Is(cause, ErrRequestTimeout):
		return DisconnectRequestTimeout
	default:
		return DisconnectUnknown
	}
}

func (value *RPC) closureReason() DisconnectReason {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.reason
}

func (value *LocalWorker) disconnected(rpc *RPC, generation uint64, executor *Executor) {
	value.mu.Lock()
	current := !value.closed && value.ctx.Err() == nil && value.generation == generation && value.rpc == rpc
	if current {
		value.rpc = nil
		value.status = contracts.ConnectionStatusOffline
		value.account, value.models = nil, nil
		value.lastError = contracts.Some("executor_disconnected")
	}
	value.mu.Unlock()
	if !current {
		return
	}
	value.changed()

	reason := rpc.closureReason()
	if value.options.Disconnected == nil || reason == DisconnectExplicit || reason == DisconnectContext {
		return
	}
	info := DisconnectInfo{Generation: generation, Reason: reason}
	timer := time.NewTimer(ExecutorStopTimeout)
	defer timer.Stop()
	select {
	case <-executor.Stopped:
		info.ProcessStopped = true
	case <-timer.C:
	case <-value.ctx.Done():
		return
	}
	if executor.ExitInfo != nil {
		info.Exit = executor.ExitInfo()
	}

	value.mu.Lock()
	current = !value.closed && value.ctx.Err() == nil && value.generation == generation && value.executor == executor && value.status == contracts.ConnectionStatusOffline
	value.mu.Unlock()
	if current {
		value.options.Disconnected(info)
	}
}
