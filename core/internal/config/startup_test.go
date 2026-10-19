package config

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestEnvironmentQuotedValuesMatchPinnedNodeFixtures(t *testing.T) {
	fixtures := []struct {
		source string
		want   map[string]string
	}{
		{"A=x\nB=\"hello\\nworld\"\nC='x\\ny'\nD=`z`", map[string]string{"A": "x", "B": "hello\nworld", "C": `x\ny`, "D": "z"}},
		{"export A = abc #comment\nA=last\nB=one=two\nC=\"line\nsecond\"", map[string]string{"A": "last", "B": "one=two", "C": "line\nsecond"}},
		{" A= yes\u0085\nB=\ufeffok\ufeff\nC=\"unterminated", map[string]string{"A": "yes\u0085", "B": "\ufeffok\ufeff", "C": `"unterminated`}},
		{"A=\"quoted\"tail\nB='x' #comment\nC=bare#hash", map[string]string{"A": "quoted", "B": "x", "C": "bare"}},
	}
	for _, fixture := range fixtures {
		actual, err := ParseEnvironment([]byte(fixture.source))
		if err != nil || !reflect.DeepEqual(actual, fixture.want) {
			t.Fatalf("environment fixture differs: %v", err)
		}
	}
}

func TestStartupUsesDynamicDirectoriesAndNeverLoadsExample(t *testing.T) {
	root := filepath.Join(t.TempDir(), "非默认 用户目录")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env.example"), []byte("DANT_PORT=9999\nOPENAI_API_KEY=example-placeholder\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	input := StartupInput{
		WorkingDirectory: root,
		Home:             filepath.Join(root, "用户 home"),
		Hostname:         "fixture-vm",
		Username:         "fixture-user",
		Environment:      []string{"DANT_PORT=4319", "EXISTING=", "UNRELATED=literal"},
	}
	startup, err := LoadStartup(input)
	if err != nil || startup.Listen.Port != 4319 || startup.DataDir != filepath.Join(root, "data") ||
		startup.RuntimeID != "vm:fixture-vm:fixture-user" || startup.Environment["OPENAI_API_KEY"] != "" {
		t.Fatalf("dynamic startup: %+v %v", startup.Listen, err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("DANT_PORT=4329\nEXISTING=should-not-override\nOPTIONAL=literal\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	startup, err = LoadStartup(input)
	if err != nil || startup.Listen.Port != 4319 || startup.Environment["EXISTING"] != "" || startup.Environment["OPTIONAL"] != "literal" {
		t.Fatalf("existing environment precedence: %v", err)
	}
	if startup.WorkspaceRoot != filepath.Join(input.Home, "dant", "workspaces") {
		t.Fatal("workspace uses a hardcoded user directory")
	}
	input.Environment = append(input.Environment, "DANT_MANAGED=1")
	startup, err = LoadStartup(input)
	if err != nil || startup.Listen != NativeEndpoint() {
		t.Fatal("managed desktop changed the native IPC endpoint")
	}
}

func TestStartupRejectsUnknownOrDuplicateRoles(t *testing.T) {
	root := t.TempDir()
	for _, arguments := range [][]string{
		{"--role=invalid"}, {"--role=worker", "--role=controller"},
		{"--vm-worker", "--role=controller"}, {"--role=worker", "--prepare"},
		{"--role"}, {"--arbitrary"},
	} {
		_, err := LoadStartup(StartupInput{Arguments: arguments, WorkingDirectory: root, Home: root, Hostname: "fixture", Username: "user"})
		if !errors.Is(err, ErrStartup) {
			t.Fatalf("invalid arguments accepted: %v", arguments)
		}
	}
}

func TestManagedInputKeepsDevelopmentPortsAndSeparateConfigurationRoot(t *testing.T) {
	project := t.TempDir()
	resources := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, ".env"), []byte("DANT_PORT=4417\nDANT_WORKSPACE_ROOT=workspaces\n"), 0600); err != nil {
		t.Fatal(err)
	}
	startup, err := LoadStartup(StartupInput{
		Arguments:        []string{"--root", resources, "--config-root", project},
		Environment:      []string{"DANT_MANAGED_STDIN=1"},
		WorkingDirectory: project, Home: project, Hostname: "fixture", Username: "user",
	})
	if err != nil || !startup.ManagedInput || startup.Listen.Port != 4417 || startup.Root != resources {
		t.Fatal("managed development startup lost its separate boundaries", err)
	}
	if startup.WorkspaceRoot != filepath.Join(resources, "workspaces") {
		t.Fatal("relative runtime directory did not use the resource root")
	}
}

func TestPrepareWorkerExplicitPathsAndManagedInputValidation(t *testing.T) {
	root := t.TempDir()
	backup := filepath.Join(root, "snapshot.raw")
	workspace := filepath.Join(root, "existing-workspaces")
	input := StartupInput{
		Arguments:        []string{"--role=prepare-worker", "--workspace-root", workspace, "--backup", backup},
		WorkingDirectory: root, Home: root, Hostname: "fixture", Username: "user",
	}
	startup, err := LoadStartup(input)
	if err != nil || startup.Backup != backup || startup.WorkspaceRoot != workspace {
		t.Fatal("prepare paths were not retained", err)
	}
	input.Arguments = []string{"--role=worker", "--backup", backup}
	if _, err := LoadStartup(input); !errors.Is(err, ErrStartup) {
		t.Fatal("live worker accepted a prepare-only archive", err)
	}
	input.Arguments = nil
	input.Environment = []string{"DANT_MANAGED_STDIN=yes"}
	if _, err := LoadStartup(input); !errors.Is(err, ErrStartup) {
		t.Fatal("unknown managed input value accepted", err)
	}
}
