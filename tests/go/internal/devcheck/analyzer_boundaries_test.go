package devcheck

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStateAnalyzerRetainsDomainsThroughTypedBindingsParenthesesAndPropertyIndexes(t *testing.T) {
	for _, source := range []string{
		`var wire (contracts.TaskStatus) = "running"`,
		`func f(status contracts.TaskStatus){if status=="running"{}}`,
		`var wire contracts.TaskStatus;func f(){if wire=="running"{}}`,
		`var wire=contracts.TaskStatusRunning;func f(){if wire=="paused"{}}`,
		`func f(){other,wire:=0,contracts.TaskStatusRunning;_=other;if wire=="paused"{}}`,
		`func f(){if statuses[0]=="running"{}}`,
		`func f(){if value["status"]=="running"{}}`,
		`func f(){wire:="paused";task.Status=(wire)}`,
		`var taskPhase="acknowledged"`,
		`var taskStage="working"`,
		`var provider="hyperv"`,
		`var backupMode="automatic"`,
		`var goos="linux"`,
		`var hostPlatform="win32"`,
		`var submission="unknown"`,
		`var powerState="running"`,
	} {
		found := analyzeStateSource(t, "package fixture\nimport contracts \"github.com/Stephen-Sim/dant/core/internal/contracts\"\n"+source)
		if len(found) != 1 {
			t.Fatal("typed or named state binding escaped the state contract gate", source, len(found))
		}
	}
	if found := analyzeStateSource(t, "package fixture\nimport . \"github.com/Stephen-Sim/dant/core/internal/contracts\"\nvar wire TaskStatus=\"running\""); len(found) != 1 {
		t.Fatal("dot-imported state type escaped validation")
	}
	for _, source := range []string{
		`func declared() contracts.TaskStatus`,
		`func f(){if task.Status==2{}}`,
		`func f(){if task.Status==(2-1){}}`,
		`var status = external.Value`,
		`var ordinary = []int{1,2}`,
	} {
		if found := analyzeStateSource(t, "package fixture\nimport external \"example.invalid/synthetic\"\nimport contracts \"github.com/Stephen-Sim/dant/core/internal/contracts\"\n"+source); len(found) != 0 {
			t.Fatal("nonliteral or unrelated type was treated as a known state", source)
		}
	}
	var aliases strings.Builder
	for index := 0; index < 20; index++ {
		fmt.Fprintf(&aliases, "type A%d A%d;", index, index+1)
	}
	aliases.WriteString(`type A20 contracts.TaskStatus;var unrelated A0="running"`)
	if found := analyzeStateSource(t, "package fixture\nimport contracts \"github.com/Stephen-Sim/dant/core/internal/contracts\"\n"+aliases.String()); len(found) != 0 {
		t.Fatal("unbounded type recursion exceeded its analysis budget")
	}
}

func TestStateGateRejectsMalformedSchemaAndNonDirectorySourceRoot(t *testing.T) {
	for _, raw := range []string{`{"version":1,"version":1}`, `{"version":"one","domains":{}}`} {
		root := stateCheckRoot(t)
		if err := os.WriteFile(filepath.Join(root, "resources", "contracts", "state-domains.json"), []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := CheckStateContracts(t.Context(), root); !errors.Is(err, ErrStateContracts) {
			t.Fatal("malformed canonical state schema was accepted", err)
		}
	}
	file := filepath.Join(t.TempDir(), "ordinary-file")
	if err := os.WriteFile(file, []byte("synthetic"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := CheckStateContracts(t.Context(), file); !errors.Is(err, ErrStateContracts) {
		t.Fatal("an ordinary file was accepted as the source root", err)
	}
}
