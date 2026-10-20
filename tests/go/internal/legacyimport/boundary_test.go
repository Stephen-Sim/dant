package legacyimport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImportRejectsInvalidFormatsAndUnsafeLegacyPathsBeforeCreatingATarget(t *testing.T) {
	for _, test := range []struct {
		manifest string
		state    string
	}{
		{`{`, `{}`}, {`[]`, `{}`}, {`{"id":null}`, `{}`}, {`{"id":3}`, `{}`},
		{`{"id":""}`, `{}`}, {`{"id":"unsafe\nidentity"}`, `{}`},
		{`{"id":"one-import"}`, `{"messages":{}}`},
		{`{"id":"one-import"}`, `{"messages":[null]}`},
		{`{"id":"one-import"}`, `{"messages":[{"attachments":{}}]}`},
		{`{"id":"one-import"}`, `{"messages":[{"attachments":[null]}]}`},
		{`{"id":"one-import"}`, `{"messages":[{"attachments":[{"id":"../outside","name":"unsafe"}]}]}`},
		{`{"id":"one-import"}`, `{"messages":[{"attachments":[{"id":"one/two"}]}]}`},
		{`{"id":"one-import"}`, `{"messages":[{"attachments":[{"id":42}]}]}`},
		{`{"id":"one-import"}`, `{"messages":[{"attachments":[{"id":"one","name":null}]}]}`},
		{`{"id":"one-import"}`, `{"settings":42}`},
		{`{"id":"one-import"}`, `{"workTasks":[{"continuation":42}]}`},
		{`{"id":"one-import"}`, `{"schedules":[null]}`},
	} {
		options := exportFixture(t, test.state, nil)
		_ = os.WriteFile(filepath.Join(options.SourceDir, manifestName), []byte(test.manifest), 0600)
		if _, err := Import(t.Context(), options); err == nil {
			t.Fatal("invalid legacy format or a path-traversal identifier was accepted")
		}
		if _, err := os.Stat(options.TargetDir); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("format validation wrote a destination", err)
		}
	}
	options := exportFixture(t, `{}`, nil)
	for _, invalid := range []Options{
		{SourceDir: "relative", TargetDir: options.TargetDir},
		{SourceDir: options.SourceDir, TargetDir: "relative"},
		{SourceDir: options.SourceDir, TargetDir: options.SourceDir},
		{SourceDir: options.SourceDir, TargetDir: filepath.Join(options.SourceDir, "nested")},
		{SourceDir: options.SourceDir, TargetDir: filepath.Dir(options.SourceDir)},
	} {
		if _, err := Import(t.Context(), invalid); !errors.Is(err, ErrInvalid) {
			t.Fatal("an overlapping or relative import boundary was accepted", err)
		}
	}
}

func TestImportRejectsHardlinkedSourcesAndCapacityViolationsBeforeWriting(t *testing.T) {
	for _, variant := range []string{"hardlinked attachment", "hardlinked state", "directory attachment", "oversized attachment", "too many files"} {
		t.Run(variant, func(t *testing.T) {
			options := exportFixture(t, `{"messages":[{"attachments":[{"id":"one","name":"one.bin"}]}]}`, map[string][]byte{"one": {0, 1, 2}})
			switch variant {
			case "hardlinked attachment":
				if err := os.Link(filepath.Join(options.SourceDir, "files", "one"), filepath.Join(options.SourceDir, "second-link")); err != nil {
					t.Fatal(err)
				}
			case "hardlinked state":
				if err := os.Link(filepath.Join(options.SourceDir, stateName), filepath.Join(options.SourceDir, "second-link")); err != nil {
					t.Fatal(err)
				}
			case "directory attachment":
				_ = os.Remove(filepath.Join(options.SourceDir, "files", "one"))
				_ = os.Mkdir(filepath.Join(options.SourceDir, "files", "one"), 0700)
			case "oversized attachment":
				file, err := os.OpenFile(filepath.Join(options.SourceDir, "files", "one"), os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				if err := file.Truncate(maxFileBytes + 1); err != nil {
					t.Fatal(err)
				}
				_ = file.Close()
			case "too many files":
				entries := []map[string]string{}
				for index := range maxLegacyFiles + 1 {
					entries = append(entries, map[string]string{"id": strings.Repeat("x", index/100+1) + strings.Repeat("y", index%100+1)})
				}
				raw, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"attachments": entries}}})
				_ = os.WriteFile(filepath.Join(options.SourceDir, stateName), raw, 0600)
			}
			if _, err := Import(t.Context(), options); err == nil {
				t.Fatal("unsafe source storage or an excessive import was accepted")
			}
			if _, err := os.Stat(options.TargetDir); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("source safety validation wrote a destination", err)
			}
		})
	}
}

func TestCapturedSourceRejectsChangedBytesAndNewlyAvailableMissingFiles(t *testing.T) {
	for _, changed := range []string{manifestName, stateName, "attachment", "missing attachment"} {
		options := exportFixture(t, `{"messages":[{"attachments":[{"id":"one","name":"one.bin"},{"id":"missing","name":"missing.bin"}]}]}`, map[string][]byte{"one": {0, 1, 2}})
		captured, err := readSource(t.Context(), options.SourceDir)
		if err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(options.SourceDir, changed)
		if changed == "attachment" {
			file = filepath.Join(options.SourceDir, "files", "one")
		} else if changed == "missing attachment" {
			file = filepath.Join(options.SourceDir, "files", "missing")
		}
		before, _ := os.ReadFile(file)
		if err := os.WriteFile(file, append(before, ' '), 0600); err != nil {
			t.Fatal(err)
		}
		if err := captured.unchanged(t.Context()); !errors.Is(err, ErrChanged) {
			t.Fatal("a captured source accepted changed or newly available bytes", err)
		}
		_ = captured.root.Close()
	}
}

func TestExclusivePublicationRetainsAnExistingAuthoritativeFileAndPartialFence(t *testing.T) {
	options := exportFixture(t, `{"messages":[]}`, nil)
	_ = os.Mkdir(options.TargetDir, 0700)
	target, err := openDestination(options.TargetDir)
	if err != nil {
		t.Fatal(err)
	}
	defer target.close()
	if err := target.exclusive(t.Context(), journalName, []byte(`{"partial":"durable fence"}`)); err != nil {
		t.Fatal(err)
	}
	existing := []byte(`{"messages":[{"id":"independently-written-work"}]}`)
	if err := os.WriteFile(filepath.Join(options.TargetDir, stateName), existing, 0600); err != nil {
		t.Fatal(err)
	}
	if err := target.exclusive(t.Context(), stateName, []byte(`{"messages":[]}`)); !errors.Is(err, ErrUnconfirmed) {
		t.Fatal("exclusive publication replaced authoritative state", err)
	}
	if _, err := Import(t.Context(), options); !errors.Is(err, ErrUnconfirmed) {
		t.Fatal("a partial durable fence was replayed", err)
	}
	current, _ := os.ReadFile(filepath.Join(options.TargetDir, stateName))
	if !bytes.Equal(current, existing) {
		t.Fatal("failed import changed independently written work")
	}
}

func TestCLIHasOnlyExplicitOfflineArgumentsAndBoundedResultMetadata(t *testing.T) {
	options := exportFixture(t, `{"messages":[],"memory":"private user memory"}`, nil)
	for _, args := range [][]string{
		{}, {"--source-dir"}, {"--source-dir", options.SourceDir},
		{"--source-dir", options.SourceDir, "--data-dir", options.TargetDir, "--data-dir", options.TargetDir},
		{"--source-dir", options.SourceDir, "--data-dir", options.TargetDir, "--run-model"},
	} {
		var output bytes.Buffer
		if err := RunCLI(t.Context(), args, &output); !errors.Is(err, ErrInvalid) || output.Len() != 0 {
			t.Fatal("ambiguous CLI arguments ran an import or printed source data", err)
		}
	}
	var output bytes.Buffer
	if err := RunCLI(t.Context(), []string{"--source-dir=" + options.SourceDir, "--data-dir", options.TargetDir}, &output); err != nil {
		t.Fatal(err)
	}
	var result Result
	if json.Unmarshal(output.Bytes(), &result) != nil || !result.OK || bytes.Contains(output.Bytes(), []byte("private")) || bytes.Contains(output.Bytes(), []byte(options.SourceDir)) {
		t.Fatal("CLI stdout contained private state or an invalid result")
	}
	missing := exportFixture(t, `{}`, nil)
	_ = os.Remove(filepath.Join(missing.SourceDir, manifestName))
	if result, err := Import(t.Context(), missing); err != nil || !result.Skipped {
		t.Fatal("an absent legacy export was not a safe no-op", err)
	}
	if _, err := os.Stat(missing.TargetDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("an absent export created a target", err)
	}
}

func TestArchiveNameAndEmptyBinaryStayCompatibleWithAttachmentReaders(t *testing.T) {
	options := exportFixture(t, `{"messages":[{"attachments":[{"id":"empty","name":"folder/\u0001"},{"id":"unicode","name":"`+strings.Repeat("😀", 121)+`"}]}]}`, map[string][]byte{"empty": {}, "unicode": {0, 255}})
	if _, err := Import(t.Context(), options); err != nil {
		t.Fatal(err)
	}
	state := importedState(t, options)
	messages, _ := objects(state["messages"], false)
	attachments, _ := objects(messages[0]["attachments"], false)
	if name, _ := text(attachments[0]["name"]); name != "file" {
		t.Fatal("control-only display name did not use the shared safe fallback")
	}
	if name, _ := text(attachments[1]["name"]); len([]rune(name)) != 120 {
		t.Fatal("an astral display name exceeded the attachment UTF-16 limit")
	}
	if string(attachments[0]["size"]) != "0" {
		t.Fatal("empty binary content was treated as unavailable")
	}
}

func TestPublicationRejectsAnInvalidOrChangedDestinationCapability(t *testing.T) {
	options := exportFixture(t, `{}`, nil)
	if _, err := openDestination(options.TargetDir); !errors.Is(err, ErrChanged) {
		t.Fatal("missing destination was implicitly created outside owner acquisition", err)
	}
	if err := os.Mkdir(options.TargetDir, 0700); err != nil {
		t.Fatal(err)
	}
	target, err := openDestination(options.TargetDir)
	if err != nil {
		t.Fatal(err)
	}
	defer target.close()
	if err := target.exclusive(t.Context(), "../outside", nil); !errors.Is(err, ErrChanged) {
		t.Fatal("publication escaped its anchored leaf namespace", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := target.exclusive(ctx, "cancelled", nil); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled publication created a file", err)
	}
	if _, err := os.Stat(filepath.Join(options.TargetDir, "cancelled")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cancelled publication left a file", err)
	}
}
