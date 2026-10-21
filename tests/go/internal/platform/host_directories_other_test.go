//go:build !windows

package platform

import (
	"errors"
	"testing"
)

func TestSimulatedWindowsHostRequiresAllSelectedDirectoriesOnOtherPlatforms(t *testing.T) {
	for _, missing := range []string{"SystemRoot", "ProgramFiles", "ProgramFiles(x86)"} {
		environment := map[string]string{"SystemRoot": `R:\FixtureWindows`, "ProgramFiles": `S:\FixturePrograms`, "ProgramFiles(x86)": `T:\FixturePrograms`}
		delete(environment, missing)
		if _, err := New("windows", environment, nil); !errors.Is(err, ErrHostConfiguration) {
			t.Fatal("a non-Windows simulation guessed a host installation path", missing, err)
		}
	}
}
