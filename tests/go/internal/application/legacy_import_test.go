package application

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/buildinfo"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/legacyimport"
)

type legacyImportUnexpectedInput struct{ t *testing.T }

func (input legacyImportUnexpectedInput) Read([]byte) (int, error) {
	input.t.Error("offline import tried to read managed service input")
	return 0, io.EOF
}

func TestExplicitLegacyImportRoleUsesTheOfflineCLIWithoutServiceStartup(t *testing.T) {
	version, source := buildinfo.Version, buildinfo.Source
	buildinfo.Version, buildinfo.Source = "0.4.7-beta.15", strings.Repeat("a", 40)
	t.Cleanup(func() { buildinfo.Version, buildinfo.Source = version, source })
	root := t.TempDir()
	exported := filepath.Join(root, "export")
	target := filepath.Join(root, "private-import")
	if err := os.Mkdir(exported, 0700); err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string]string{
		"manifest.json": `{"id":"fixture-import"}`,
		"state.json":    `{"messages":[],"settings":{},"memory":"private fixture text"}`,
	} {
		if err := os.WriteFile(filepath.Join(exported, name), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var output bytes.Buffer
	if err := Run(t.Context(), []string{
		"--role=" + string(config.RoleLegacyImport), "--source-dir", exported, "--data-dir", target,
	}, legacyImportUnexpectedInput{t}, &output); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(output.Bytes(), []byte("listening")) || bytes.Contains(output.Bytes(), []byte("private fixture")) {
		t.Fatal("offline child started a service or emitted user text")
	}
	if _, err := os.Stat(filepath.Join(target, "migration-imported.json")); err != nil {
		t.Fatal("thin process role did not dispatch to the actual importer", err)
	}
	if _, err := os.Stat(filepath.Join(target, "memory")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("offline import opened a Worker memory writer", err)
	}
	output.Reset()
	if err := Run(t.Context(), []string{"--role=" + string(config.RoleLegacyImport), "--prepare"}, legacyImportUnexpectedInput{t}, &output); !errors.Is(err, legacyimport.ErrInvalid) || output.Len() != 0 {
		t.Fatal("offline child accepted service or preparation flags", err)
	}
}

func TestLegacyImportCannotEnterTheNormalServiceConfigurationParser(t *testing.T) {
	root := t.TempDir()
	if !config.RoleLegacyImport.Valid() {
		t.Fatal("the named offline process role is missing from the role domain")
	}
	_, err := config.LoadStartup(config.StartupInput{
		Arguments:        []string{"--role=" + string(config.RoleLegacyImport)},
		WorkingDirectory: root, Executable: filepath.Join(root, "fixture"), Home: root,
		Hostname: "fixture-host", Username: "fixture-user",
	})
	if !errors.Is(err, config.ErrStartup) {
		t.Fatal("offline import could be assembled as a network service", err)
	}
}
