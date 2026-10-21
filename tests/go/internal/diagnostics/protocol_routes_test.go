package diagnostics

import (
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/config"
)

func TestDiagnosticGuestRoutesFollowTheProtocolWithoutBroadeningTheirAllowlist(t *testing.T) {
	logger := newLogger(t, Options{DataDir: t.TempDir(), Role: "worker"})
	paths := config.DefaultProtocol().Paths
	inputs := []string{paths.Health, paths.Screen, paths.Input, paths.Control, paths.Health + "?private=value", paths.File, paths.ReadFile}
	for _, route := range inputs {
		if !logger.Log("http.request", Fields{Method: "GET", Route: route}) {
			t.Fatal("bounded request metadata was refused")
		}
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	records, err := logger.Recent(t.Context(), len(inputs))
	if err != nil || len(records) != len(inputs) {
		t.Fatal("canonical guest metadata was not retained", err)
	}
	for index, expected := range []string{paths.Health, paths.Screen, paths.Input, paths.Control, "", "", ""} {
		if records[index].Route != expected {
			t.Fatal("guest route reuse broadened the diagnostic route or query allowlist")
		}
	}
}
