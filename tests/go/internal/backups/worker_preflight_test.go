package backups

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func preflightFixture(t *testing.T) WorkerPreflightOptions {
	t.Helper()
	options := restoreFixture(t)
	if err := os.WriteFile(filepath.Join(options.DataDir, "state.json"), []byte(restoreFixtureState), 0600); err != nil {
		t.Fatal(err)
	}
	return WorkerPreflightOptions{DataDir: options.DataDir, WorkspaceRoot: options.WorkspaceRoot, SourceID: "isolated-preflight"}
}

func TestWorkerPreflightIsReadOnlyAndBoundsTheAgentDataArchive(t *testing.T) {
	options := preflightFixture(t)
	for _, directory := range []string{filepath.Join(options.DataDir, "logs"), filepath.Join(options.WorkspaceRoot, "node_modules"), filepath.Join(options.WorkspaceRoot, "empty")} {
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{filepath.Join(options.DataDir, "logs", "excluded"), filepath.Join(options.WorkspaceRoot, "node_modules", "excluded")} {
		if err := os.WriteFile(name, []byte("excluded"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	content := bytes.Repeat([]byte{0, 255, 1, 42, 13}, ChunkBytes/5+1)
	name := filepath.Join(skillFixtureRoot(t, options.WorkspaceRoot), "unicode-&-\u2028-日本語.bin")
	if err := os.WriteFile(name, content, 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}

	footprint, err := PreflightWorkerBackup(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	expectedData := int64(len(restoreFixtureState))
	expectedContent := expectedData + int64(len(content))
	if footprint.Files != 2 || footprint.ContentBytes != expectedContent || footprint.DataBytes != expectedData {
		t.Fatal("unexpected included metadata", footprint)
	}
	if footprint.StagingBytes < footprint.ContentBytes || footprint.RequiredBytes != footprint.StagingBytes+footprint.ArchiveBytes+PreflightHeadroomBytes {
		t.Fatal("capacity omitted staging or durable-output headroom")
	}
	after, err := os.Stat(name)
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("preflight changed the source")
	}
	parent := filepath.Dir(options.DataDir)
	children, err := os.ReadDir(parent)
	if err != nil || len(children) != 2 {
		t.Fatal("preflight created a staging directory or lock")
	}

	capture, err := CreateWorkerBackup(t.Context(), WorkerBackupOptions{
		DataDir:       options.DataDir,
		WorkspaceRoot: options.WorkspaceRoot,
		TemporaryRoot: parent,
		SourceID:      options.SourceID,
		AppVersion:    "0.4.7",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer capture.Close()
	var encoded bytes.Buffer
	if err := capture.WriteTo(t.Context(), &encoded); err != nil || int64(encoded.Len()) > footprint.ArchiveBytes {
		t.Fatal("preflight underestimated the encoded archive", err)
	}
	archive, err := ValidateArchive(t.Context(), bytes.NewReader(encoded.Bytes()), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	roundTrip, err := os.ReadFile(filepath.Join(archive.Directory, "workspace", testRestoreID, ".agents", "skills", filepath.Base(name)))
	if err != nil || !bytes.Equal(roundTrip, content) {
		t.Fatal("opaque file bytes changed without per-file staging Sync")
	}
}

func TestPreflightCLIUsesNoOfflineServiceOrWriteLockAndNeverEmitsPartialJSON(t *testing.T) {
	options := preflightFixture(t)
	arguments := []string{"preflight", "--data-dir", options.DataDir, "--workspace-root", options.WorkspaceRoot, "--source-id", options.SourceID}
	service := &fakeBackupService{running: true}
	var output bytes.Buffer
	if err := RunCLI(t.Context(), arguments, strings.NewReader("must not be consumed"), &output, CLIOptions{Service: service}); err != nil {
		t.Fatal(err)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(output.Bytes(), &object); err != nil || len(object) != 6 || service.starts != 0 {
		t.Fatal("invalid footprint output or unexpected service action", err)
	}
	for _, key := range []string{"files", "contentBytes", "dataBytes", "stagingBytes", "archiveBytes", "requiredBytes"} {
		var value int64
		if json.Unmarshal(object[key], &value) != nil || value < 0 {
			t.Fatal("invalid bounded integer footprint")
		}
	}
	if bytes.Contains(output.Bytes(), []byte(options.DataDir)) || bytes.Contains(output.Bytes(), []byte(options.SourceID)) {
		t.Fatal("preflight output leaked an identity or path")
	}

	for _, invalid := range [][]string{
		append(append([]string{}, arguments...), "--restore-id", testRestoreID),
		append(append([]string{}, arguments...), "--source-id", "duplicate"),
		{"preflight", "--data-dir", options.DataDir, "--workspace-root", options.WorkspaceRoot},
	} {
		output.Reset()
		if RunCLI(t.Context(), invalid, nil, &output) == nil || output.Len() != 0 {
			t.Fatal("invalid CLI produced a footprint")
		}
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	output.Reset()
	if err := RunCLI(cancelled, arguments, nil, &output); !errors.Is(err, context.Canceled) || output.Len() != 0 {
		t.Fatal("cancelled preflight produced success", err)
	}
}

func TestWorkerPreflightRejectsMissingNestedLinkedOversizedAndUnrecognizedSources(t *testing.T) {
	for _, scenario := range []string{"missing-state", "missing-workspace", "nested-roots", "oversized-file", "aggregate-limit", "hardlink", "unknown-link"} {
		t.Run(scenario, func(t *testing.T) {
			options := preflightFixture(t)
			switch scenario {
			case "missing-state":
				if err := os.Remove(filepath.Join(options.DataDir, "state.json")); err != nil {
					t.Fatal(err)
				}
			case "missing-workspace":
				options.WorkspaceRoot = filepath.Join(options.WorkspaceRoot, "missing")
			case "nested-roots":
				options.DataDir = options.WorkspaceRoot
			case "oversized-file", "aggregate-limit":
				count := 1
				size := MaxFileBytes + 1
				if scenario == "aggregate-limit" {
					count, size = 6, MaxFileBytes
				}
				for index := range count {
					file, err := os.Create(filepath.Join(skillFixtureRoot(t, options.WorkspaceRoot), strings.Repeat("x", index+1)))
					if err != nil {
						t.Fatal(err)
					}
					if err := sparsePreflightFixture(file, size); err != nil {
						file.Close()
						t.Fatal(err)
					}
					if err := file.Close(); err != nil {
						t.Fatal(err)
					}
				}
			case "hardlink":
				if err := os.Link(filepath.Join(options.WorkspaceRoot, "original"), filepath.Join(skillFixtureRoot(t, options.WorkspaceRoot), "linked")); err != nil {
					t.Fatal(err)
				}
			case "unknown-link":
				if err := os.Symlink(filepath.Join(options.WorkspaceRoot, "original"), filepath.Join(skillFixtureRoot(t, options.WorkspaceRoot), "linked")); err != nil {
					t.Skip("isolated symlink creation unavailable")
				}
			}
			if _, err := PreflightWorkerBackup(t.Context(), options); err == nil {
				t.Fatal("unknown or unsupported source produced a footprint")
			}
		})
	}
}

func TestWorkerPreflightExcludesBrowserProfilesRegardlessOfRuntimeLockFormat(t *testing.T) {
	options := preflightFixture(t)
	profile := filepath.Join(options.WorkspaceRoot, "browser-profile")
	if err := os.Mkdir(profile, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"prefs.js", "times.json", "compatibility.ini"} {
		if err := os.WriteFile(filepath.Join(profile, name), []byte("isolated marker"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(profile, "places.sqlite"), []byte(sqliteMagic+"opaque fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("isolated-host:+1234", filepath.Join(profile, "lock")); err != nil {
		t.Skip("isolated symlink creation unavailable")
	}

	footprint, err := PreflightWorkerBackup(t.Context(), options)
	if err != nil || footprint.Files != 1 {
		t.Fatal("browser profile contents were included", err)
	}
	if err := os.WriteFile(filepath.Join(profile, "places.sqlite"), []byte("not a SQLite-format marker"), 0600); err != nil {
		t.Fatal(err)
	}
	if footprint, err := PreflightWorkerBackup(t.Context(), options); err != nil || footprint.Files != 1 {
		t.Fatal("out-of-scope browser data affected the estimate", err)
	}
}

func TestWorkerPreflightStopsDuringScanningAndRejectsChangedObservedSources(t *testing.T) {
	options := preflightFixture(t)
	base, cancel := context.WithCancel(t.Context())
	defer cancel()
	cancelled := &preflightCheckCancellation{Context: base, cancel: cancel, remaining: 6}
	if _, err := PreflightWorkerBackup(cancelled, options); !errors.Is(err, context.Canceled) {
		t.Fatal("scan did not retain cancellation", err)
	}

	scanner := footprintScanner{
		ctx:       t.Context(),
		workspace: options.WorkspaceRoot,
		observed:  workerCapture{ctx: t.Context()},
	}
	if err := scanner.directory(options.WorkspaceRoot, "workspace", captureBoundaryPrefix); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(options.WorkspaceRoot, "original"), []byte("changed source"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := scanner.observed.validate(); !errors.Is(err, ErrSourceChanged) {
		t.Fatal("changed metadata produced an authoritative footprint", err)
	}

	scanner.entries = MaxFiles
	if err := scanner.child(options.WorkspaceRoot, "workspace", captureBoundaryPrefix, "original"); err == nil {
		t.Fatal("bounded entry budget admitted another real source file")
	}
}

type preflightCheckCancellation struct {
	context.Context
	cancel    context.CancelFunc
	remaining int
}

func (value *preflightCheckCancellation) Err() error {
	value.remaining--
	if value.remaining == 0 {
		value.cancel()
	}
	return value.Context.Err()
}

func TestEphemeralCaptureStillRejectsTamperingCancellationAndPartialArchiveWriters(t *testing.T) {
	options := preflightFixture(t)
	capture, err := CreateWorkerBackup(t.Context(), WorkerBackupOptions{
		DataDir:       options.DataDir,
		WorkspaceRoot: options.WorkspaceRoot,
		TemporaryRoot: filepath.Dir(options.DataDir),
		SourceID:      options.SourceID,
		AppVersion:    "0.4.7",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer capture.Close()

	var partial bytes.Buffer
	writer := &failedFootprintWriter{output: &partial, remaining: int64(len(ArchiveMagic) + 100)}
	if err := capture.WriteTo(t.Context(), writer); !errors.Is(err, io.ErrClosedPipe) || bytes.Contains(partial.Bytes(), []byte(`"type":"footer"`)) {
		t.Fatal("failed archive writer produced successful completion", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := capture.WriteTo(cancelled, io.Discard); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}

	name := filepath.Join(capture.Archive.Directory, "data", "state.json")
	if err := os.WriteFile(name, []byte("tampered workspace"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := capture.WriteTo(t.Context(), io.Discard); !errors.Is(err, ErrSourceChanged) {
		t.Fatal("private staging tampering escaped final SHA256 validation", err)
	}
}

type failedFootprintWriter struct {
	output    *bytes.Buffer
	remaining int64
}

func (writer *failedFootprintWriter) Write(value []byte) (int, error) {
	if int64(len(value)) > writer.remaining {
		return 0, io.ErrClosedPipe
	}
	writer.remaining -= int64(len(value))
	return writer.output.Write(value)
}
