package config

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestStartupRejectsInvalidFlagsPathsAndEnvironmentAtTheConfigurationBoundary(t *testing.T) {
	root := t.TempDir()
	base := StartupInput{WorkingDirectory: root, Home: root, Hostname: "synthetic-host", Username: "synthetic-user"}
	for _, arguments := range [][]string{
		{"--role="}, {"--root", ""}, {"--root", "bad\x00path"}, {"--config-root", "bad\npath"},
		{"--data-dir", "bad\rpath"}, {"--workspace-root", "bad\npath"}, {"--backup", ""},
		{"--role=worker", "--vm-worker"}, {"--vm-worker=yes"}, {"--prepare=1"}, {"--prepare", "--prepare"},
		{"--deploy-worker=1"}, {"--deploy-worker", "--deploy-worker"}, {"--role=worker", "--deploy-worker"},
		{"--role=legacy-import"}, {"--role=prepare-worker", "--backup", "bad\narchive"},
	} {
		input := base
		input.Arguments = arguments
		if _, err := LoadStartup(input); !errors.Is(err, ErrStartup) {
			t.Fatalf("invalid arguments %q were accepted: %v", arguments, err)
		}
	}
	for _, environment := range []string{
		"DANT_RUNTIME_ID=" + strings.Repeat("x", 257), "DANT_RUNTIME_ID=bad\nidentity", "DANT_WORKSPACE_ROOT=bad\rpath",
		"DANT_HOST=remote.invalid", "DANT_DEV_PORT=70000", "DANT_GUEST_HOST=remote.invalid", "DANT_GUEST_PORT=4317",
	} {
		input := base
		input.Environment = []string{environment}
		if _, err := LoadStartup(input); err == nil {
			t.Fatal("invalid deployment option was accepted")
		}
	}
	input := base
	input.Home = "bad\x00home"
	if _, err := LoadStartup(input); !errors.Is(err, ErrStartup) {
		t.Fatal("invalid dynamic home was accepted", err)
	}
	input = base
	input.Arguments = []string{"--root", "resources", "--data-dir", "private", "--prepare", "--deploy-worker"}
	input.Environment = []string{"DANT_DATA=ignored", "DANT_WORKSPACE_ROOT=work", "DANT_RUNTIME_ID=synthetic-runtime"}
	startup, err := LoadStartup(input)
	if err != nil || startup.Root != filepath.Join(root, "resources") || startup.DataDir != filepath.Join(root, "resources", "private") || !startup.PrepareOnly || !startup.DeployWorker || startup.RuntimeID != "synthetic-runtime" {
		t.Fatal("explicit paths and controller preparation flags were not preserved", err)
	}
	input = base
	input.Arguments = []string{"--vm-worker"}
	input.Environment = []string{"DANT_DATA=alternate-data"}
	if startup, err := LoadStartup(input); err != nil || startup.Role != RoleWorker || startup.DataDir != filepath.Join(root, "alternate-data") {
		t.Fatal("documented worker shorthand or environment data directory changed", err)
	}
}

func TestProjectEnvironmentRejectsInvalidOrUnmanagedFilesWithoutModifyingProcessValues(t *testing.T) {
	for _, raw := range [][]byte{
		[]byte("INVALID-KEY=value"), {0xff}, []byte("A=x\x00y"), []byte(strings.Repeat("x", MaxEnvBytes+1)),
	} {
		if _, err := ParseEnvironment(raw); !errors.Is(err, ErrStartup) {
			t.Fatal("invalid environment document was accepted", err)
		}
	}
	for _, raw := range []string{"INVALID-KEY=value", "A='unterminated #comment\n", "# comment\nignored\nA=\n \t\n"} {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, ".env"), []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		input := StartupInput{WorkingDirectory: root, Home: root}
		_, err := LoadStartup(input)
		if strings.HasPrefix(raw, "INVALID") != errors.Is(err, ErrStartup) {
			t.Fatal("project environment classification changed", err)
		}
	}
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".env"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadProjectEnvironment(root, map[string]string{"EXISTING": "synthetic"}); !errors.Is(err, ErrStartup) {
		t.Fatal("environment directory was accepted as a file", err)
	}
	actual := EnvironmentList(CaptureEnvironment([]string{"B=two=parts", "A=first", "A=last", "missing", "=invalid", "bad\x00key=x", "C=bad\x00value"}))
	if !reflect.DeepEqual(actual, []string{"A=last", "B=two=parts"}) {
		t.Fatal("captured environment lost deterministic ordering or validation", actual)
	}
	if _, err := Port("", 0); !errors.Is(err, ErrNetwork) {
		t.Fatal("invalid default port was accepted", err)
	}
}
