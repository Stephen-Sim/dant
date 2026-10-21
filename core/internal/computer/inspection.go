package computer

import (
	_ "embed"
	"encoding/json"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/config"
)

// Embedding keeps first-connection probes independent of files installed by an
// older worker. The same Python source is measured by the VM helper test suite.
//
//go:embed assets/worker_inspection.py
var workerInspectionSource string

func workerInspectionCommand(operation string) string {
	protocol := config.DefaultProtocol()
	configuration, _ := json.Marshal(struct {
		Origin  string `json:"origin"`
		Session string `json:"session"`
		Version string `json:"version"`
		State   string `json:"state"`
	}{
		Origin:  config.NativeEndpoint().HTTPOrigin,
		Session: protocol.Paths.Session,
		Version: protocol.Paths.Version,
		State:   protocol.Paths.State,
	})

	argument := "'" + strings.ReplaceAll(string(configuration), "'", "'\"'\"'") + "'"
	return "python3 - " + operation + " " + argument + " <<'PY'\n" + workerInspectionSource + "\nPY"
}
