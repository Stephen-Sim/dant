package backups

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const cliFixtureState = `{"conversationId":"49954ce5-c8c5-4f6e-a7d8-531530d09479","settings":{},"messages":[],"workTasks":[],"completions":[],"schedules":[]}`

func TestBackupCLIExportValidatesPrivateSnapshotBeforeAnyOutput(t *testing.T) {
	for _, relative := range []string{"memory/dant/memory.sqlite", "schedules/schedules.sqlite", "telegram.json", "state.json"} {
		t.Run(relative, func(t *testing.T) {
			root := t.TempDir()
			data := filepath.Join(root, "data")
			workspace := filepath.Join(root, "workspace")
			staging := filepath.Join(root, "temporary")
			for _, directory := range []string{data, workspace, staging} {
				if err := os.Mkdir(directory, 0700); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range []string{"TMP", "TEMP", "TMPDIR"} {
				t.Setenv(name, staging)
			}
			if err := os.WriteFile(filepath.Join(data, "state.json"), []byte(cliFixtureState), 0600); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(data, filepath.FromSlash(relative))
			if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
				t.Fatal(err)
			}
			original := []byte("malformed private fixture")
			if err := os.WriteFile(file, original, 0600); err != nil {
				t.Fatal(err)
			}

			service := &fakeBackupService{}
			var output bytes.Buffer
			err := RunCLI(t.Context(), []string{"export", "--data-dir", data, "--workspace-root", workspace, "--source-id", "isolated"}, bytes.NewReader(nil), &output, CLIOptions{AppVersion: "0.4.7-beta.20", Service: service})
			if !errors.Is(err, ErrInvalid) || output.Len() != 0 {
				t.Fatalf("corrupt source published archive bytes: error=%v bytes=%d", err, output.Len())
			}
			current, err := os.ReadFile(file)
			if err != nil || !bytes.Equal(current, original) || service.starts != 0 {
				t.Fatal("failed export changed source or started worker")
			}
			entries, err := os.ReadDir(staging)
			if err != nil || len(entries) != 0 {
				t.Fatal("failed snapshot validation leaked private staging")
			}
		})
	}
}
