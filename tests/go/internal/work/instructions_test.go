package work

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestDefaultToolDeclarationsRemainCompleteAndIndependent(t *testing.T) {
	tools := DynamicTools()
	if len(tools) != 19 {
		t.Fatal("dynamic tools were lost during migration")
	}
	names := map[string]bool{}
	for _, tool := range tools {
		var declaration struct {
			Name        string              `json:"name"`
			Description string              `json:"description"`
			InputSchema contracts.RawObject `json:"inputSchema"`
		}
		if json.Unmarshal(tool, &declaration) != nil || declaration.Name == "" || declaration.Description == "" || string(declaration.InputSchema["additionalProperties"]) != "false" {
			t.Fatal("tool permission schema was weakened")
		}
		names[declaration.Name] = true
	}
	for _, name := range []string{"task_plan", "task_cancel", "credential_get", "credential_request", "skill_save", "schedule_save", "end_call"} {
		if !names[name] {
			t.Fatal("required permission-specific tool missing")
		}
	}
	tools[0][0] = '!'
	if !json.Valid(DynamicTools()[0]) {
		t.Fatal("caller mutated global tool declarations")
	}
}

func TestDefaultInstructionsUseCurrentLanguageAndPreserveAuthorityRules(t *testing.T) {
	engine, persistence, _ := engineFixture(t)
	if err := persistence.Mutate(context.Background(), func(state *contracts.State) error {
		state.Settings.Language = "ja"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	instructions, err := engine.InstructionsContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"Japanese", "The user is the human", "not new work requests", "Never echo or log secrets", "Do not create a new task for each sentence"} {
		if !strings.Contains(instructions, required) {
			t.Fatal("critical instruction or current language lost")
		}
	}
	if strings.Contains(instructions, "{{") {
		t.Fatal("unresolved instruction template token")
	}
}
