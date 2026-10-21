package files

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOutputReferencesPreserveDynamicRootsAndRejectAmbiguousPaths(t *testing.T) {
	root := t.TempDir()
	name := filepath.Join(root, "report 中文.txt")
	for _, value := range []string{
		"file://localhost/" + strings.TrimPrefix(filepath.ToSlash(name), "/"),
		"sandbox:" + filepath.ToSlash(name),
	} {
		if actual, ok := OutputReference(root, value, true); !ok || actual != filepath.Base(name) {
			t.Fatalf("dynamic absolute reference was not retained: %q", actual)
		}
	}
	for _, input := range []struct {
		root, value string
	}{
		{root, ""}, {root, string([]byte{255})}, {root, "line\nfile"},
		{"relative", "report.txt"}, {root, "."},
		{root, strings.Repeat("nested/", MaxOutputDepth+1) + "report.txt"},
		{root, "file:opaque"}, {root, "file://localhost/path?query"},
		{root, "file://localhost/path#fragment"}, {root, "bad%GG.txt"},
	} {
		if _, ok := OutputReference(input.root, input.value, true); ok {
			t.Fatal("ambiguous or unbounded file reference was accepted")
		}
	}
}

func TestOutputScanBoundsNestedTreesAndOmitsIneligibleFiles(t *testing.T) {
	for _, mode := range []string{"nested", "depth", "hardlink", "large-file", "total-budget", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			name := filepath.Join(root, "result.bin")
			if mode == "nested" || mode == "depth" {
				depth := 2
				if mode == "depth" {
					depth = MaxOutputDepth + 1
				}
				directory := filepath.Join(root, filepath.FromSlash(strings.Repeat("nested/", depth)))
				if err := os.MkdirAll(directory, 0700); err != nil {
					t.Fatal(err)
				}
				name = filepath.Join(directory, "result.bin")
			}
			if err := os.WriteFile(name, []byte{0, 255, 17}, 0600); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "hardlink":
				if err := os.Link(name, filepath.Join(t.TempDir(), "outside.bin")); err != nil {
					t.Fatal(err)
				}
			case "large-file":
				if err := os.Truncate(name, MaxAttachmentBytes+1); err != nil {
					t.Fatal(err)
				}
			case "total-budget":
				for index := 0; index < MaxOutputScanBytes/MaxAttachmentBytes+1; index++ {
					path := filepath.Join(root, fmt.Sprintf("bounded-%02d.bin", index))
					if err := os.WriteFile(path, nil, 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.Truncate(path, MaxAttachmentBytes); err != nil {
						t.Fatal(err)
					}
				}
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			result, err := scanOutput(ctx, root)
			switch mode {
			case "depth", "total-budget":
				if !errors.Is(err, ErrOutputLimit) {
					t.Fatal("unbounded output tree was scanned", err)
				}
			case "cancelled":
				if !errors.Is(err, context.Canceled) {
					t.Fatal("cancelled output scan continued")
				}
			case "hardlink", "large-file":
				if err != nil || len(result) != 0 {
					t.Fatal("ineligible output became a deliverable", err)
				}
			default:
				if err != nil || len(result) != 1 || result[0].relative != filepath.Join("nested", "nested", "result.bin") {
					t.Fatal("nested deliverable was lost", err)
				}
			}
		})
	}
}

func TestDeliverableOwnerAndStorageFailuresDoNotPublishStaleAttachments(t *testing.T) {
	for _, mode := range []string{"before-read", "after-read", "storage", "automatic-storage", "storage-owner-changed", "output-unavailable", "missing"} {
		t.Run(mode, func(t *testing.T) {
			store, err := OpenAttachmentStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			output := t.TempDir()
			if err := os.WriteFile(filepath.Join(output, "result.bin"), []byte{0, 255, 17}, 0600); err != nil {
				t.Fatal(err)
			}
			alive := true
			checks := 0
			notices := []string{}
			collector := NewDeliverableCollector(store, func(code string) { notices = append(notices, code) })
			input := ArchiveInput{
				OutputDirectory: output,
				ExplicitPaths:   []string{"result.bin"},
				OnlyExplicit:    true,
				IsCurrent: func() bool {
					checks++
					if (mode == "before-read" && checks >= 2) || (mode == "after-read" && checks >= 3) {
						return false
					}
					return alive
				},
			}
			if mode == "storage" || mode == "automatic-storage" || mode == "storage-owner-changed" {
				store.write = func(string, []byte) (fs.FileInfo, error) {
					if mode == "storage-owner-changed" {
						alive = false
					}
					return nil, io.ErrClosedPipe
				}
			}
			if mode == "automatic-storage" || mode == "storage-owner-changed" {
				input.ExplicitPaths = nil
				input.OnlyExplicit = false
				input.Baseline = json.RawMessage(`{"valid":true,"hashes":{}}`)
			}
			if mode == "output-unavailable" {
				input.OutputDirectory = "relative"
			}
			if mode == "missing" {
				input.ExplicitPaths = []string{"missing.bin"}
			}
			result, err := collector.ArchiveExplicit(t.Context(), input)
			stale := mode == "before-read" || mode == "after-read" || mode == "storage-owner-changed"
			if (stale && !errors.Is(err, context.Canceled)) || (!stale && err != nil) || len(result) != 0 {
				t.Fatal("stale or unavailable output was published", err)
			}
			if (mode == "automatic-storage" || mode == "storage-owner-changed") && (len(notices) != 1 || notices[0] != "output_delivery_unavailable") {
				t.Fatal("failed automatic delivery lost its bounded diagnostic")
			}
			entries, err := os.ReadDir(store.Directory())
			if err != nil || len(entries) != 0 {
				t.Fatal("failed or stale delivery retained attachment bytes")
			}
		})
	}
}

func TestDeliverableLimitsAndExplicitExclusionsKeepSuccessfulResultsBounded(t *testing.T) {
	store, err := OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	output := t.TempDir()
	paths := []string{}
	for index := 0; index < MaxMessageAttachments+2; index++ {
		name := fmt.Sprintf("result-%02d.txt", index)
		paths = append(paths, name)
		if err := os.WriteFile(filepath.Join(output, name), []byte("retained"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	collector := NewDeliverableCollector(store, nil)
	for _, explicit := range []bool{false, true} {
		input := ArchiveInput{OutputDirectory: output, Baseline: json.RawMessage(`{"valid":true,"hashes":{}}`), ExcludePaths: []string{paths[0], "../invalid"}}
		if explicit {
			input.ExplicitPaths = paths
			input.OnlyExplicit = true
		}
		result, err := collector.ArchiveExplicit(t.Context(), input)
		if err != nil || len(result) != MaxMessageAttachments {
			t.Fatal("delivery limit discarded all results or exceeded the message limit", err)
		}
		for _, item := range result {
			if item.Name == paths[0] || filepath.Dir(item.SourcePath) != output {
				t.Fatal("explicit exclusion or dynamic output ownership was lost")
			}
		}
	}
	if _, _, err := collector.ReadExplicit(t.Context(), output, "../outside"); !errors.Is(err, ErrManagedPath) {
		t.Fatal("explicit read accepted traversal")
	}
	if _, _, err := collector.ReadExplicit(t.Context(), "relative", "result.txt"); err == nil {
		t.Fatal("explicit read accepted a relative managed root")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := collector.CaptureBaseline(cancelled, output); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled baseline was presented as valid")
	}
}
