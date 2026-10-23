package app

import (
	"strings"
	"testing"

	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
)

func TestExecutorDisconnectDiagnosticsRetainOnlyClassifiedTransportAndExitMetadata(t *testing.T) {
	app := fixtureWorker(t)
	app.reportExecutorDisconnect(workerRuntime.DisconnectInfo{
		Generation: 3, Reason: workerRuntime.DisconnectEOF, ProcessStopped: true,
		Exit: workerRuntime.ProcessExit{Observed: true, Code: -1, Signal: 15, StopRequested: true},
	})
	app.reportExecutorDisconnect(workerRuntime.DisconnectInfo{Generation: 4, Reason: workerRuntime.DisconnectReadError})
	app.Close()
	records, err := app.diagnostics.Recent(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	found, unknown := false, false
	for _, record := range records {
		if record.Event != "worker.connection" || record.Code != workerDisconnectedCode {
			continue
		}
		if record.Reason == "eof" {
			found = record.Status == "offline" && record.Transport == "stdio" && record.Phase == "process-exited" &&
				record.ExecutorStopped != nil && *record.ExecutorStopped && record.ExitCode != nil && *record.ExitCode == -1 &&
				record.Signal == "15" && record.Operation == "stop-requested"
		} else if record.Reason == "read-error" {
			unknown = record.Phase == "process-exit-unconfirmed" && record.ExitCode == nil && record.Signal == "" &&
				record.ExecutorStopped != nil && !*record.ExecutorStopped
		}
	}
	if !found || !unknown || strings.Contains(string(encode(records)), "private synthetic stderr") {
		t.Fatal("disconnect diagnostics lost observed/unknown exit semantics or exposed output")
	}
	(&WorkerApp{}).reportExecutorDisconnect(workerRuntime.DisconnectInfo{})
}
