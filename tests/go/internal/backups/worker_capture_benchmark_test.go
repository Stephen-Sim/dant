package backups

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func BenchmarkWorkerCaptureSmallFiles(b *testing.B) {
	const fileCount = 512
	const fileBytes = 4096

	root := b.TempDir()
	data := filepath.Join(root, "data")
	workspace := filepath.Join(root, "workspace")
	for _, directory := range []string{data, workspace} {
		if err := os.Mkdir(directory, 0700); err != nil {
			b.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(data, "state.json"), []byte(restoreFixtureState), 0600); err != nil {
		b.Fatal(err)
	}
	content := make([]byte, fileBytes)
	for index := range content {
		content[index] = byte(index)
	}
	for index := range fileCount {
		if err := os.WriteFile(filepath.Join(skillFixtureRoot(b, workspace), fmt.Sprintf("file-%04d.bin", index)), content, 0600); err != nil {
			b.Fatal(err)
		}
	}
	options := WorkerBackupOptions{
		DataDir:       data,
		WorkspaceRoot: workspace,
		TemporaryRoot: root,
		SourceID:      "isolated-benchmark",
		AppVersion:    "0.4.7",
	}
	b.SetBytes(fileCount * fileBytes)
	b.ReportAllocs()
	b.ResetTimer()

	for range b.N {
		capture, err := CreateWorkerBackup(context.Background(), options)
		if err != nil {
			b.Fatal(err)
		}
		if capture.Archive.Manifest.Files != fileCount+1 {
			b.Fatal("isolated fixture was not fully captured")
		}
		if err := capture.Close(); err != nil {
			b.Fatal(err)
		}
	}
}
