package platform

import (
	"errors"
	"testing"
)

func TestWindowsDirectorySelectionUsesExplicitValuesAndValidatesDynamicResults(t *testing.T) {
	for _, key := range []string{"SystemRoot", "ProgramFiles", "ProgramFiles(x86)"} {
		t.Run(key, func(t *testing.T) {
			selected, err := selectedWindowsDirectory(map[string]string{key: `R:/Selected/../Owned`}, key, func(string) (string, error) {
				t.Fatal("an explicit selected directory queried the native host")
				return "", nil
			})
			if err != nil || selected != `R:\Owned` {
				t.Fatal("configured host directory did not retain precedence", err)
			}
			calls := 0
			selected, err = selectedWindowsDirectory(nil, key, func(actual string) (string, error) {
				calls++
				if actual != key {
					t.Fatal("directory discovery changed its captured identity")
				}
				return `S:\Dynamic Installation`, nil
			})
			if err != nil || calls != 1 || selected != `S:\Dynamic Installation` {
				t.Fatal("missing directory did not use one validated native observation", err)
			}
			for _, invalid := range []string{"", "relative", "T:\\Unsafe\nInjected"} {
				if _, err := selectedWindowsDirectory(nil, key, func(string) (string, error) { return invalid, nil }); !errors.Is(err, ErrHostConfiguration) {
					t.Fatal("invalid native host directory acquired authority", err)
				}
			}
			if _, err := selectedWindowsDirectory(nil, key, func(string) (string, error) { return "", errors.New("synthetic native failure with private metadata") }); err != ErrHostConfiguration {
				t.Fatal("native directory error lost its bounded classification", err)
			}
		})
	}
}
