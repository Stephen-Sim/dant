package app

import (
	"strconv"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/diagnostics"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
)

const workerDisconnectedCode = "WORKER_DISCONNECTED"

func (app *WorkerApp) reportExecutorDisconnect(info workerRuntime.DisconnectInfo) {
	if app.diagnostics == nil {
		return
	}
	fields := diagnostics.Fields{
		Code:            workerDisconnectedCode,
		Status:          string(contracts.ConnectionStatusOffline),
		Reason:          string(info.Reason),
		Transport:       "stdio",
		ExecutorStopped: &info.ProcessStopped,
	}
	if info.Exit.Observed {
		code := int64(info.Exit.Code)
		fields.ExitCode = &code
		fields.Phase = "process-exited"
	} else {
		fields.Phase = "process-exit-unconfirmed"
	}
	if info.Exit.Signal > 0 {
		fields.Signal = strconv.Itoa(info.Exit.Signal)
	}
	if info.Exit.StopRequested {
		fields.Operation = "stop-requested"
	}
	app.diagnostics.Log("worker.connection", fields)
}
