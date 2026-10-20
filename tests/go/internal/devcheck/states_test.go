package devcheck

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func canonicalStateSchema(t *testing.T) stateSchema {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	schema, err := readStateSchema(root)
	if err != nil {
		t.Fatal(err)
	}
	return schema
}

func analyzeStateSource(t *testing.T, source string) []StateViolation {
	t.Helper()
	positions := token.NewFileSet()
	file, err := parser.ParseFile(positions, "core/internal/work/fixture.go", source, 0)
	if err != nil {
		t.Fatal(err)
	}
	schema := canonicalStateSchema(t)
	domains := make([]string, 0, len(schema.Domains))
	for domain := range schema.Domains {
		domains = append(domains, domain)
	}
	return newStateAnalyzer(positions, "core/internal/work/fixture.go", file, schema, domains).check()
}

func TestGoStateASTRejectsRawAssignmentsComparisonsSwitchesAndTypedCollections(t *testing.T) {
	for _, fixture := range []struct {
		name, source string
		want         int
	}{
		{"field assignment", `func f(){ task.Status = "running" }`, 1},
		{"comparison", `func f(){ if task.Status == "running" {} }`, 1},
		{"reverse comparison", `func f(){ if "paused" != task.Status {} }`, 1},
		{"optional status", `func f(){ if task.Submission.Value == "unknown" {} }`, 1},
		{"switch", `func f(){ switch task.Status { case "running", "paused": } }`, 2},
		{"string conversion switch", `func f(){ switch string(task.Status) { case "running": } }`, 1},
		{"typed variable", `var value contracts.TaskStatus = "running"`, 1},
		{"typed return", `func f() contracts.TaskStatus { return "running" }`, 1},
		{"named return", `func f() (result contracts.TaskStatus, ok bool) { return "running",true }`, 1},
		{"explicit conversion", `func f(){ _ = contracts.TaskStatus("running") }`, 1},
		{"typed alias", `type Local = contracts.TaskStatus; var value Local = "running"`, 1},
		{"typed map key", `var choices = map[contracts.TaskStatus]bool{"running":true}`, 1},
		{"typed map value", `var choices = map[string]contracts.TaskStatus{"value":"running"}`, 1},
		{"state map", `var allowedStatuses = map[string]bool{"running":true,"paused":true}`, 2},
		{"state slice", `var allowedStatuses = []string{"running","paused"}`, 2},
		{"typed slice", `var choices = []contracts.TaskStatus{"running"}`, 1},
		{"contains set", `var choices=[]string{"running"};func f(){ _=slices.Contains(choices,string(task.Status)) }`, 1},
		{"JSON state value", `var raw = map[string]string{"status":"running"}`, 1},
		{"struct state value", `var raw = contracts.WorkRecord{Status:"running"}`, 1},
		{"constant indirection", `const wire="running";func f(){ task.Status=wire }`, 1},
		{"local wire indirection", `func f(){ wire:="running"; task.Status=wire }`, 1},
		{"local state list", `func f(){ choices:=[]string{"running"};_=slices.Contains(choices,string(task.Status)) }`, 1},
		{"constant expression", `func f(){ task.Status="run"+"ning" }`, 1},
		{"local variable inference", `func f(){ value:=contracts.TaskStatusRunning;value="paused" }`, 1},
		{"state setter", `func f(){ task.SetStatus("running") }`, 1},
		{"state wrapper", `func f(){task.Status=fmt.Sprint("running")}`, 1},
		{"generic optional state", `func f(){task.Status=contracts.Some[contracts.MessageStatus]("running")}`, 1},
		{"typed helper", `func write(value contracts.TaskStatus){};func f(){write("running")}`, 1},
		{"ordered comparison", `func f(){if task.Status < "running" {}}`, 1},
		{"state map values", `var savedStatuses=map[string]string{"label":"running"}`, 1},
		{"nested return", `func f(){ _=func() contracts.TaskStatus { return "running" } }`, 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			found := analyzeStateSource(t, "package fixture\nimport contracts \"github.com/Stephen-Sim/dant/core/internal/contracts\"\n"+fixture.source)
			if len(found) != fixture.want {
				t.Fatalf("raw state detection count=%d, wanted=%d", len(found), fixture.want)
			}
			for _, violation := range found {
				if violation.Line != 3 || violation.Column < 1 || violation.File != "core/internal/work/fixture.go" {
					t.Fatal("state diagnostic lost its exact source position")
				}
			}
		})
	}
}

func TestGoStateASTPreservesDomainIdentityPropertyKeysProseAndExternalValues(t *testing.T) {
	for _, source := range []string{
		`func f(){ task.Status=contracts.TaskStatusRunning }`,
		`func f(raw string){ task.Status=contracts.TaskStatus(raw) }`,
		`func f(){ text:="running"; _=text }`,
		`var labels=map[string]string{"running":"Running","paused":"Paused"}`,
		`var raw=struct{Text string}{Text:"running"}`,
		`var state=map[string]any{"paused":"ordinary property"}`,
		"type Entry struct { Status string `json:\"status\"` }",
		`func f(){ task.Priority="running" }`,
		`func f(){ task.Status="invented-external-state" }`,
		`var note="This task is running."`,
		`type A B; type B A; var item A`,
	} {
		if found := analyzeStateSource(t, "package fixture\nimport contracts \"github.com/Stephen-Sim/dant/core/internal/contracts\"\n"+source); len(found) != 0 {
			t.Fatal("non-state text or a separate state domain was incorrectly rejected")
		}
	}
	aliased := "package fixture\nimport c \"github.com/Stephen-Sim/dant/core/internal/contracts\"\nvar value c.TaskStatus = \"running\""
	if len(analyzeStateSource(t, aliased)) != 1 {
		t.Fatal("import alias bypassed the state domain gate")
	}
}

func stateCheckRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	schema := canonicalStateSchema(t)
	raw, err := json.Marshal(schema)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "resources", "contracts"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "resources", "contracts", "state-domains.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	for _, rule := range stateRules {
		directory := filepath.Join(root, filepath.FromSlash(rule.directory))
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "fixture.go"), []byte("package fixture\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestGoStateGateRecursivelyDiscoversAdoptedFilesAndReportsDeterministicLocations(t *testing.T) {
	root := stateCheckRoot(t)
	directory := filepath.Join(root, "core", "internal", "work", "nested")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "later.go"), []byte("package nested\nfunc f(){ task.Status=\"running\" }\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "fixture_test.go"), []byte("package nested\nfunc f(){ task.Status=\"paused\" }\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := RunStateContracts(context.Background(), root, &output); !errors.Is(err, ErrStateViolations) {
		t.Fatal(err)
	}
	var report StateReport
	if json.Unmarshal(output.Bytes(), &report) != nil || report.CheckedFiles != len(stateRules)+1 || len(report.Violations) != 1 || report.Violations[0].File != "core/internal/work/nested/later.go" || report.Violations[0].Line != 2 {
		t.Fatal("recursive state gate omitted an adopted source or scanned test fixtures")
	}
}

func TestGoStateGateIncludesLegacyImportStateFencesRecursively(t *testing.T) {
	root := stateCheckRoot(t)
	directory := filepath.Join(root, "core", "internal", "legacyimport", "nested")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	source := `package nested
import contracts "github.com/Stephen-Sim/dant/core/internal/contracts"
var task contracts.TaskStatus = "paused"
var submission contracts.SubmissionStatus = "unknown"
var continuation contracts.ContinuationDispatchPhase = "claimed"
var schedule contracts.ScheduleStatus = "paused"
var dispatch contracts.ScheduleDispatchPhase = "held"
var spoken contracts.SpokenReferenceStatus = "unknown"
`
	if err := os.WriteFile(filepath.Join(directory, "fences.go"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	report, err := CheckStateContracts(context.Background(), root)
	if err != nil || len(report.Violations) != 6 {
		t.Fatalf("legacy import state fences escaped check: count=%d error=%v", len(report.Violations), err)
	}
	for _, violation := range report.Violations {
		if violation.File != "core/internal/legacyimport/nested/fences.go" {
			t.Fatal("legacy import source scope lost its defining file")
		}
	}
	if err := os.RemoveAll(filepath.Join(root, "core", "internal", "legacyimport")); err != nil {
		t.Fatal(err)
	}
	if _, err := CheckStateContracts(context.Background(), root); !errors.Is(err, ErrStateContracts) {
		t.Fatal("missing legacy import scope was silently accepted")
	}
}

func TestGoStateGateRejectsMissingEmptyInvalidAndLinkedInputs(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		change func(string) error
	}{
		{"missing schema", func(root string) error {
			return os.Remove(filepath.Join(root, "resources", "contracts", "state-domains.json"))
		}},
		{"invalid schema", func(root string) error {
			return os.WriteFile(filepath.Join(root, "resources", "contracts", "state-domains.json"), []byte(`{"version":1,"domains":{}}`), 0600)
		}},
		{"missing module", func(root string) error { return os.RemoveAll(filepath.Join(root, "core", "internal", "store")) }},
		{"empty module", func(root string) error {
			return os.Remove(filepath.Join(root, "core", "internal", "store", "fixture.go"))
		}},
		{"invalid syntax", func(root string) error {
			return os.WriteFile(filepath.Join(root, "core", "internal", "store", "fixture.go"), []byte(`package fixture; func (`), 0600)
		}},
		{"hardlinked source", func(root string) error {
			return os.Link(filepath.Join(root, "core", "internal", "store", "fixture.go"), filepath.Join(root, "linked.go"))
		}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			root := stateCheckRoot(t)
			if err := fixture.change(root); err != nil {
				t.Fatal(err)
			}
			if _, err := CheckStateContracts(context.Background(), root); err == nil {
				t.Fatal("invalid or incomplete adopted scope was silently accepted")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := CheckStateContracts(ctx, stateCheckRoot(t)); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled state scan continued")
	}
	if _, err := CheckStateContracts(context.Background(), "relative"); err == nil {
		t.Fatal("relative source root accepted")
	}
}

func TestGoStateGateResolvesPackageConstantsAliasesAndHelpersAcrossFiles(t *testing.T) {
	root := stateCheckRoot(t)
	directory := filepath.Join(root, "core", "internal", "work")
	sources := map[string]string{
		"wire_windows.go": "package fixture\nconst wire=\"running\"\n",
		"wire_linux.go":   "package fixture\nconst wire=\"paused\"\n",
		"alias.go":        "package fixture\nimport c \"github.com/Stephen-Sim/dant/core/internal/contracts\"\n//line imaginary.go:100\ntype Alias=c.TaskStatus\nfunc write(value Alias){}\n",
		"consumer.go":     "package fixture\nimport contracts \"github.com/Stephen-Sim/dant/core/internal/contracts\"\nfunc initial() contracts.TaskStatus { return wire }\nvar next Alias=\"running\"\nfunc use(){write(\"paused\")}\n",
	}
	for name, source := range sources {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
	}
	report, err := CheckStateContracts(context.Background(), root)
	if err != nil || len(report.Violations) != 4 {
		t.Fatalf("cross-file state boundary escaped check: count=%d error=%v", len(report.Violations), err)
	}
	counts := map[string]int{}
	for _, failure := range report.Violations {
		counts[filepath.Base(failure.File)]++
	}
	if counts["wire_windows.go"] != 1 || counts["wire_linux.go"] != 1 || counts["consumer.go"] != 2 {
		t.Fatal("cross-file state diagnostics lost the actual defining file or platform branch")
	}
}

type stateReportFailureWriter struct{}

func (stateReportFailureWriter) Write([]byte) (int, error) {
	return 0, errors.New("isolated_report_failure")
}

func TestGoStateGateRequiresCompleteCanonicalDomainsAndSuccessfulReportOutput(t *testing.T) {
	for _, change := range []func(*stateSchema){
		func(schema *stateSchema) { schema.Version = 2 },
		func(schema *stateSchema) { delete(schema.Domains, "TaskStatus") },
		func(schema *stateSchema) {
			schema.Domains["TaskStatus"]["Duplicate"] = schema.Domains["TaskStatus"]["Running"]
		},
		func(schema *stateSchema) { schema.Domains["TaskStatus"]["TooLong"] = strings.Repeat("x", 129) },
	} {
		root := stateCheckRoot(t)
		schema := canonicalStateSchema(t)
		change(&schema)
		raw, err := json.Marshal(schema)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "resources", "contracts", "state-domains.json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := CheckStateContracts(context.Background(), root); !errors.Is(err, ErrStateContracts) {
			t.Fatal("incomplete or ambiguous canonical state vocabulary was accepted")
		}
	}
	root := stateCheckRoot(t)
	if err := RunStateContracts(context.Background(), root, stateReportFailureWriter{}); err == nil {
		t.Fatal("failed state report output was treated as a successful check")
	}
	var output bytes.Buffer
	if err := RunStateContracts(context.Background(), root, &output); err != nil {
		t.Fatal(err)
	}
	var report StateReport
	if json.Unmarshal(output.Bytes(), &report) != nil || report.CheckedFiles != len(stateRules) || report.Violations == nil || len(report.Violations) != 0 {
		t.Fatal("clean state scan omitted its successful module coverage")
	}
	if _, err := CheckStateContracts(nil, root); !errors.Is(err, ErrStateContracts) {
		t.Fatal("missing scan owner accepted")
	}
}

func TestMigratedPlanBoundaryRetainsNamedVocabularyAndRejectsUnknownWireValues(t *testing.T) {
	input := contracts.RawObject{"title": json.RawMessage(`"Verify"`), "status": json.RawMessage(`"waiting_user"`), "steps": json.RawMessage(`[{"step":"Verify","status":"pending"}]`)}
	plan, err := workstate.ReadPlanInput(input, nil)
	if err != nil || len(plan.Plan.Steps) != 1 || plan.Plan.Steps[0].Status != contracts.PlanStepStatusPending {
		t.Fatal("named plan vocabulary changed")
	}
	input["steps"] = json.RawMessage(`[{"step":"Verify","status":"in_progress"}]`)
	if _, err := workstate.ReadPlanInput(input, nil); err == nil {
		t.Fatal("unknown plan wire value was coerced into a valid step")
	}
	for _, domain := range stateRules {
		if !strings.HasPrefix(domain.directory, "core/internal/") {
			t.Fatal("adopted source escaped feature ownership")
		}
	}
}
