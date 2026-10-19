package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/skills"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func discoveryFixture(t *testing.T) (string, skills.View) {
	t.Helper()
	workspace := t.TempDir()
	return workspace, skills.View{Summary: skills.Summary{
		Name: "fixture-skill", Enabled: true,
		Path: filepath.Join(workspace, ".agents", "skills", "fixture-skill", "SKILL.md"),
	}}
}

func TestSkillDiscoveryReportsOnlyExactWorkspaceNamePathAndEnabledMatches(t *testing.T) {
	workspace, skill := discoveryFixture(t)
	for _, test := range []struct {
		name string
		rows []contracts.RawObject
		want bool
	}{
		{"exact", []contracts.RawObject{{"cwd": encode(workspace), "skills": encode([]skills.Summary{skill.Summary}), "errors": encode([]string{})}}, true},
		{"another workspace", []contracts.RawObject{{"cwd": encode(filepath.Join(workspace, "other")), "skills": encode([]skills.Summary{skill.Summary})}}, false},
		{"same name wrong path", []contracts.RawObject{{"cwd": encode(workspace), "skills": encode([]contracts.RawObject{{"name": encode(skill.Name), "path": encode(skill.Path + ".different"), "enabled": encode(true)}})}}, false},
		{"disabled", []contracts.RawObject{{"cwd": encode(workspace), "skills": encode([]contracts.RawObject{{"name": encode(skill.Name), "path": encode(skill.Path), "enabled": encode(false)}})}}, false},
		{"legacy enabled omission", []contracts.RawObject{{"cwd": encode(workspace), "skills": encode([]contracts.RawObject{{"name": encode(skill.Name), "path": encode(skill.Path)}})}}, true},
		{"unknown enabled", []contracts.RawObject{{"cwd": encode(workspace), "skills": encode([]contracts.RawObject{{"name": encode(skill.Name), "path": encode(skill.Path), "enabled": encode("true")}})}}, false},
		{"explicit null enabled", []contracts.RawObject{{"cwd": encode(workspace), "skills": encode([]contracts.RawObject{{"name": encode(skill.Name), "path": encode(skill.Path), "enabled": encode(nil)}})}}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			result := refreshSkillDiscovery(t.Context(), skillRefresh{
				workspace: workspace, current: func() bool { return true },
				request: func(_ context.Context, method string, params contracts.RawObject) (contracts.RawObject, error) {
					calls++
					if method != "skills/list" || !bytes.Equal(params["cwds"], encode([]string{workspace})) || string(params["forceReload"]) != "true" {
						t.Fatal("discovery request changed scope or operation")
					}
					return contracts.RawObject{"data": encode(test.rows)}, nil
				},
			}, skill)
			if calls != 1 || result.Discovered == nil || *result.Discovered != test.want || result.Errors == nil || *result.Errors != 0 {
				t.Fatalf("discovery result mismatch: %+v", result)
			}
			if result.Refreshed != (test.name != "another workspace") {
				t.Fatal("unrelated cwd was treated as refreshed")
			}
		})
	}
}

func TestSkillDiscoveryCountsOnlyMatchingRecordsAndToleratesUnrelatedMalformedRecords(t *testing.T) {
	workspace, skill := discoveryFixture(t)
	data := []json.RawMessage{
		encode(nil), encode("unrelated"),
		encode(contracts.RawObject{"cwd": encode(filepath.Join(workspace, "other")), "errors": encode([]string{"ignored"})}),
		encode(contracts.RawObject{"cwd": encode(workspace), "skills": encode([]skills.Summary{skill.Summary}), "errors": encode([]string{"first"})}),
		encode(contracts.RawObject{"cwd": encode(workspace), "skills": encode(nil), "errors": encode([]string{"second", "third"})}),
	}
	result := refreshSkillDiscovery(t.Context(), skillRefresh{
		workspace: workspace, current: func() bool { return true },
		request: func(context.Context, string, contracts.RawObject) (contracts.RawObject, error) {
			return contracts.RawObject{"data": encode(data)}, nil
		},
	}, skill)
	if !result.Refreshed || result.Discovered == nil || !*result.Discovered || result.Errors == nil || *result.Errors != 3 {
		t.Fatalf("aggregate discovery result mismatch: %+v", result)
	}
}

func TestSkillDiscoveryFailureAndRetiredOwnerNeverClaimSuccessOrRetry(t *testing.T) {
	workspace, skill := discoveryFixture(t)
	for _, mode := range []string{"request failure", "bad data", "null data", "owner changed", "cancelled", "foreign skill path"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			current, calls := true, 0
			candidate := skill
			if mode == "foreign skill path" {
				candidate.Path = filepath.Join(filepath.Dir(workspace), "outside", "SKILL.md")
			}
			result := refreshSkillDiscovery(ctx, skillRefresh{
				workspace: workspace, current: func() bool { return current },
				request: func(context.Context, string, contracts.RawObject) (contracts.RawObject, error) {
					calls++
					switch mode {
					case "request failure":
						return nil, errors.New("private RPC error")
					case "bad data":
						return contracts.RawObject{"data": encode("not an array")}, nil
					case "null data":
						return contracts.RawObject{"data": encode(nil)}, nil
					case "owner changed":
						current = false
					case "cancelled":
						cancel()
					}
					return contracts.RawObject{"data": encode([]contracts.RawObject{{"cwd": encode(workspace), "skills": encode([]skills.Summary{skill.Summary})}})}, nil
				},
			}, candidate)
			if result.Refreshed || result.Discovered != nil || result.Errors != nil || calls > 1 {
				t.Fatal("failed or stale discovery claimed success or retried")
			}
		})
	}
	app := fixtureWorker(t)
	if result := app.refreshSkills(t.Context(), work.ToolContext{ConversationID: app.store.ConversationID(), IsCurrent: func() bool { return false }}, skill); result.Refreshed {
		t.Fatal("offline or retired actual Worker owner was accepted")
	}
}
