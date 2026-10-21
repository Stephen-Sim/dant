package computer

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/config"
)

func TestWorkerInspectionCommandsUseTheSharedNativeProtocol(t *testing.T) {
	protocol := config.DefaultProtocol()
	configuration, err := json.Marshal(map[string]string{
		"origin":  config.NativeEndpoint().HTTPOrigin,
		"session": protocol.Paths.Session,
		"version": protocol.Paths.Version,
		"state":   protocol.Paths.State,
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, operation := range []string{"deployment", "quiescence"} {
		command := workerInspectionCommand(operation)
		prefix := "python3 - " + operation + " '"
		if !strings.HasPrefix(command, prefix) || !strings.HasSuffix(command, "\nPY") ||
			!strings.Contains(command, workerInspectionSource) {
			t.Fatal("probe did not preserve the embedded first-connection source")
		}

		end := strings.Index(command[len(prefix):], "' <<'PY'")
		if end < 0 {
			t.Fatal("probe configuration did not cross an explicit shell argument")
		}
		var actual, expected map[string]string
		if json.Unmarshal([]byte(command[len(prefix):len(prefix)+end]), &actual) != nil ||
			json.Unmarshal(configuration, &expected) != nil {
			t.Fatal("probe configuration is not validated JSON")
		}
		for key, value := range expected {
			if actual[key] != value {
				t.Fatalf("probe bypassed shared protocol field %s", key)
			}
		}
	}
}
