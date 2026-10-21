package runtime

import (
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

// The assembler supplies a captured process environment. This feature never
// consults mutable global environment values while admitting an execution.
func executorEnvironment(options WorkerOptions) []string {
	values := make(map[string]string)
	order := make([]string, 0, len(options.Environment)+4)
	for _, entry := range options.Environment {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" || strings.ContainsRune(key, 0) || strings.ContainsRune(value, 0) {
			continue
		}
		if _, exists := values[key]; !exists {
			order = append(order, key)
		}
		values[key] = value
	}
	set := func(key, value string) {
		if _, exists := values[key]; !exists {
			order = append(order, key)
		}
		values[key] = value
	}
	set("HOME", options.Home)
	set("DANT_CREDENTIAL_BRIDGE_TOKEN", options.CredentialBridgeToken)
	set("DISPLAY", ":0")
	set("CODEX_HOME", filepath.Join(options.Home, ".dant-codex"))
	set("PATH", filepath.Join(options.Home, ".local", "bin")+":/usr/local/bin:/usr/bin:"+values["PATH"])
	result := make([]string, 0, len(order))
	for _, key := range order {
		result = append(result, key+"="+values[key])
	}
	return result
}

func cloneObject(value contracts.RawObject) contracts.RawObject {
	if value == nil {
		return nil
	}
	result := make(contracts.RawObject, len(value))
	for key, raw := range value {
		result[key] = append(json.RawMessage(nil), raw...)
	}
	return result
}
