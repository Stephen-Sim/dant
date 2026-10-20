// Package devcheck owns source-contract checks used by development and CI.
package devcheck

import (
	"context"
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const schemaLimit = 512 * 1024
const sourceLimit = 4 * 1024 * 1024

var ErrStateContracts = errors.New("state_contracts_invalid")
var ErrStateViolations = errors.New("raw_state_literals")

type stateRule struct {
	directory string
	domains   []string
}

// These recursive scopes retain every backend feature previously adopted by
// check-state-contracts.mts. New Go files in an adopted feature cannot opt out.
var stateRules = []stateRule{
	{"core/internal/store", []string{"ContinuationDispatchPhase", "PlanStepStatus", "SubmissionStatus", "TaskPriority", "TaskProgressStage", "TaskStatus"}},
	{"core/internal/work", []string{"ContinuationDispatchPhase", "PlanStepStatus", "SubmissionStatus", "TaskPriority", "TaskProgressStage", "TaskStatus", "ConnectionStatus", "RuntimeTerminalTurnStatus", "SpokenReferenceStatus"}},
	{"core/internal/memory", []string{"MemoryEntryStatus"}},
	{"core/internal/controller", []string{"DesktopPhase", "ConnectionStatus"}},
	{"core/internal/computer", []string{"VmPowerState", "VmReceiptPhase", "VmProviderId", "ServiceUpdateStatus", "ConnectionStatus", "TaskStatus", "ComputerControlStatus", "SubmissionStatus", "ProvisioningStatus"}},
	{"core/internal/platform", []string{"HostPlatformId", "RuntimeOperatingSystem"}},
	{"core/internal/backups", []string{"HostPlatformId", "RuntimeOperatingSystem", "BackupMode", "BackupPhase", "WorkerRestorePhase"}},
	{"core/internal/schedules", []string{"ScheduleStatus", "ScheduleDispatchPhase", "TaskStatus", "TaskPriority"}},
	{"core/internal/legacyimport", []string{"ContinuationDispatchPhase", "SubmissionStatus", "TaskStatus", "ScheduleStatus", "ScheduleDispatchPhase", "SpokenReferenceStatus"}},
}

type stateSchema struct {
	Version int                          `json:"version"`
	Domains map[string]map[string]string `json:"domains"`
}

type StateViolation struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Value  string `json:"value"`
}

type StateReport struct {
	CheckedFiles int              `json:"checkedFiles"`
	Violations   []StateViolation `json:"violations"`
}

type parsedStateSource struct {
	name string
	file *ast.File
}

func readStateSchema(root string) (stateSchema, error) {
	raw, err := files.ReadRegular(filepath.Join(root, "resources", "contracts", "state-domains.json"), schemaLimit)
	if err != nil {
		return stateSchema{}, ErrStateContracts
	}
	if _, err := contracts.DecodeObject(raw, schemaLimit); err != nil {
		return stateSchema{}, ErrStateContracts
	}
	var schema stateSchema
	if json.Unmarshal(raw, &schema) != nil || schema.Version != 1 || len(schema.Domains) == 0 {
		return stateSchema{}, ErrStateContracts
	}
	for _, rule := range stateRules {
		for _, name := range rule.domains {
			values := schema.Domains[name]
			if len(values) == 0 {
				return stateSchema{}, ErrStateContracts
			}
			seen := map[string]bool{}
			for key, value := range values {
				if key == "" || len(key) > 128 || value == "" || len(value) > 128 || seen[value] {
					return stateSchema{}, ErrStateContracts
				}
				seen[value] = true
			}
		}
	}
	return schema, nil
}

func CheckStateContracts(ctx context.Context, root string) (StateReport, error) {
	report := StateReport{Violations: []StateViolation{}}
	if ctx == nil || !filepath.IsAbs(root) {
		return report, ErrStateContracts
	}
	if _, err := files.OrdinaryDirectory(root, false); err != nil {
		return report, ErrStateContracts
	}
	schema, err := readStateSchema(root)
	if err != nil {
		return report, err
	}
	for _, rule := range stateRules {
		directory := filepath.Join(root, filepath.FromSlash(rule.directory))
		if _, err := files.OrdinaryDirectory(directory, false); err != nil {
			return report, ErrStateContracts
		}
		positions := token.NewFileSet()
		var sources []parsedStateSource
		err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkError error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if walkError != nil || entry.Type()&fs.ModeSymlink != 0 {
				return ErrStateContracts
			}
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
				return nil
			}
			raw, err := files.ReadRegular(path, sourceLimit)
			if err != nil {
				return ErrStateContracts
			}
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return ErrStateContracts
			}
			name := filepath.ToSlash(relative)
			file, err := parser.ParseFile(positions, name, raw, 0)
			if err != nil {
				return ErrStateContracts
			}
			sources = append(sources, parsedStateSource{name: name, file: file})
			return nil
		})
		if err != nil {
			return report, err
		}
		if len(sources) == 0 {
			return report, ErrStateContracts
		}
		packages := map[string]map[string][]*ast.Object{}
		aliases := map[string]map[string]bool{}
		for _, source := range sources {
			key := filepath.Dir(source.name) + ":" + source.file.Name.Name
			if packages[key] == nil {
				packages[key] = map[string][]*ast.Object{}
			}
			for name, object := range source.file.Scope.Objects {
				packages[key][name] = append(packages[key][name], object)
			}
			aliases[source.name] = contractImportAliases(source.file)
		}
		seen := map[token.Pos]bool{}
		for _, source := range sources {
			key := filepath.Dir(source.name) + ":" + source.file.Name.Name
			analyzer := newStateAnalyzer(positions, source.name, source.file, schema, rule.domains)
			analyzer.symbols, analyzer.fileAliases, analyzer.seen = packages[key], aliases, seen
			report.Violations = append(report.Violations, analyzer.check()...)
		}
		report.CheckedFiles += len(sources)
	}
	sort.Slice(report.Violations, func(left, right int) bool {
		a, b := report.Violations[left], report.Violations[right]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Column < b.Column
	})
	return report, nil
}

func RunStateContracts(ctx context.Context, root string, output io.Writer) error {
	report, err := CheckStateContracts(ctx, root)
	if err != nil {
		return err
	}
	if err := json.NewEncoder(output).Encode(report); err != nil {
		return err
	}
	if len(report.Violations) > 0 {
		return ErrStateViolations
	}
	return nil
}
