package backups

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type archiveWriteFailure struct {
	bytes.Buffer
	calls, failAt int
}

type archiveFirstReadHook struct {
	hook func() error
	done bool
	err  error
}

func (reader *archiveFirstReadHook) Read([]byte) (int, error) {
	if !reader.done {
		reader.done = true
		if err := reader.hook(); err != nil {
			reader.err = err
			return 0, err
		}
	}
	return 0, io.ErrUnexpectedEOF
}

func (writer *archiveWriteFailure) Write(data []byte) (int, error) {
	writer.calls++
	if writer.calls == writer.failAt {
		return 0, io.ErrClosedPipe
	}
	return writer.Buffer.Write(data)
}

func (writer *archiveWriteFailure) WriteString(data string) (int, error) {
	return writer.Write([]byte(data))
}

func TestArchiveRejectsInvalidFramesAndParentCollisionsBeforeConfirmingRestoration(t *testing.T) {
	valid := string(fixtureArchive([]byte("{}")))
	for _, fixture := range []struct {
		name  string
		input string
	}{
		{"magic", strings.Replace(valid, ArchiveMagic, "unknown", 1)},
		{"unicode", strings.Replace(valid, `"state.json"`, "\"\xff\"", 1)},
		{"object", strings.Replace(valid, `"type":"header"`, `"type":false`, 1)},
		{"duplicate-field", strings.Replace(valid, `"type":"header"`, `"type":"header","type":"header"`, 1)},
		{"header-fields", strings.Replace(valid, `"createdAt":1000,`, "", 1)},
		{"header-kind", strings.Replace(valid, `"type":"header"`, `"type":"directory"`, 1)},
		{"empty-chunk", strings.Replace(valid, `"data":"e30="`, `"data":""`, 1)},
		{"large-chunk", strings.Replace(valid, `"data":"e30="`, `"data":"`+strings.Repeat("A", 100000)+`"`, 1)},
		{"wrong-end", strings.Replace(valid, `"type":"end"`, `"type":"footer"`, 1)},
		{"footer-count", strings.Replace(valid, `"type":"footer","files":1`, `"type":"footer","files":0`, 1)},
		{"header-count", strings.Replace(valid, `"files":1`, `"files":0`, 1)},
		{"missing-state", strings.Replace(valid, `"path":"state.json"`, `"path":"other.json"`, 1)},
		{"file-in-parent", strings.Replace(valid, `"path":"state.json"`, `"path":"folder/item"`, 1)},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			if _, err := ValidateArchive(t.Context(), strings.NewReader(fixture.input), t.TempDir()); err == nil {
				t.Fatal("malformed archive was confirmed")
			}
		})
	}
	lines := strings.Split(strings.TrimSuffix(valid, "\n"), "\n")
	for _, fixture := range []struct{ first, second string }{
		{"state.json", "state.json"}, {"state.json", "state.json/child"}, {"folder/item", "folder"},
	} {
		first := append([]string{}, lines[:5]...)
		first[1] = strings.Replace(first[1], `"files":1`, `"files":2`, 1)
		first[1] = strings.Replace(first[1], `"bytes":2`, `"bytes":4`, 1)
		first[2] = strings.Replace(first[2], `"path":"state.json"`, `"path":"`+fixture.first+`"`, 1)
		second := append([]string{}, lines[2:5]...)
		second[0] = strings.Replace(second[0], `"path":"state.json"`, `"path":"`+fixture.second+`"`, 1)
		input := strings.Join(append(first, second...), "\n") + "\n" + lines[5] + "\n"
		if _, err := ValidateArchive(t.Context(), strings.NewReader(input), t.TempDir()); !errors.Is(err, ErrInvalid) {
			t.Fatal("archive replaced an existing file or an implicit parent", err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := ValidateArchive(ctx, strings.NewReader(valid), t.TempDir()); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled archive was confirmed", err)
	}
	if _, err := ValidateArchive(t.Context(), strings.NewReader(valid), "relative"); !errors.Is(err, ErrInvalid) {
		t.Fatal("unmanaged archive staging was accepted", err)
	}
}

func TestArchiveOutputFailuresRemainPartialAndNeverBecomeSuccessfulBackups(t *testing.T) {
	archive, err := ValidateArchive(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for failAt := 1; failAt <= 6; failAt++ {
		writer := &archiveWriteFailure{failAt: failAt}
		if err := WriteArchive(t.Context(), writer, archive); !errors.Is(err, io.ErrClosedPipe) || writer.calls != failAt {
			t.Fatal("archive output failure was hidden or retried", err, failAt, writer.calls)
		}
	}
	for _, change := range []func(*ValidatedArchive){
		func(value *ValidatedArchive) { value.Manifest.SchemaVersion = 2 },
		func(value *ValidatedArchive) { value.Directory = "relative" },
		func(value *ValidatedArchive) { value.Entries[0].Path = "../outside" },
		func(value *ValidatedArchive) { value.Manifest.Files++ },
	} {
		copy := archive
		copy.Entries = append([]ArchiveEntry{}, archive.Entries...)
		change(&copy)
		if err := WriteArchive(t.Context(), io.Discard, copy); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid archive metadata was emitted successfully", err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := WriteArchive(ctx, io.Discard, archive); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled archive output continued", err)
	}
	if err := os.Link(filepath.Join(archive.Directory, "data", "state.json"), filepath.Join(t.TempDir(), "linked")); err != nil {
		t.Fatal(err)
	}
	if err := WriteArchive(t.Context(), io.Discard, archive); !errors.Is(err, ErrSourceChanged) {
		t.Fatal("linked archive source was emitted", err)
	}
}

func TestRestoreFailureCannotCleanAReplacementValidationDirectory(t *testing.T) {
	options := restoreFixture(t)
	parent := filepath.Dir(options.DataDir)
	var replacement, retained string
	reader := &archiveFirstReadHook{hook: func() error {
		names, err := os.ReadDir(parent)
		if err != nil {
			return err
		}
		for _, entry := range names {
			if entry.IsDir() && strings.HasPrefix(entry.Name(), ".dant-restore-validate-") {
				if replacement != "" {
					return errors.New("ambiguous isolated decoding directory")
				}
				replacement = filepath.Join(parent, entry.Name())
			}
		}
		if replacement == "" {
			return errors.New("missing isolated decoding directory")
		}
		retained = filepath.Join(parent, "retained-validation-original")
		if err := os.Rename(replacement, retained); err != nil {
			return err
		}
		if err := os.Mkdir(replacement, 0o700); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(replacement, "unrelated-marker"), []byte("synthetic replacement"), 0o600)
	}}
	if receipt, err := RestoreWorkerBackup(t.Context(), options, reader); err == nil || receipt.Restored || !reader.done {
		t.Fatal("failed restoration was confirmed or did not inspect input", err)
	}
	if reader.err != nil {
		if !archiveReplacementDenied(reader.err) {
			t.Fatal("isolated replacement could not be prepared", reader.err)
		}
		if _, err := os.Lstat(retained); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("a denied directory replacement still moved the original", err)
		}
	} else {
		if data, err := os.ReadFile(filepath.Join(replacement, "unrelated-marker")); err != nil || string(data) != "synthetic replacement" {
			t.Fatal("failed restoration removed an unowned replacement", err)
		}
		if _, err := os.Stat(retained); err != nil {
			t.Fatal("failed restoration removed its unconfirmed original", err)
		}
	}
	for _, root := range []string{options.DataDir, options.WorkspaceRoot} {
		if _, err := os.Stat(filepath.Join(root, "original")); err != nil {
			t.Fatal("failed restoration changed live data", err)
		}
	}
}
