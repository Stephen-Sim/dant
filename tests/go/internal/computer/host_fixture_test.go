package computer

import (
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/platform"
)

func windowsComputerHost(t *testing.T, overrides map[string]string) platform.Host {
	t.Helper()
	environment := map[string]string{
		"SystemRoot": `D:\FixtureWindows`, "ProgramFiles": `E:\FixturePrograms`, "ProgramFiles(x86)": `F:\FixturePrograms`,
	}
	for name, value := range overrides {
		environment[name] = value
	}
	host, err := platform.New("windows", environment, nil)
	if err != nil {
		t.Fatal(err)
	}
	return host
}
