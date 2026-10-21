package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillArchiveRejectsUnsafeHeadersCountsExpandedSizeAndAlgorithms(t *testing.T) {
	manifest := manifestBytes("bounded", "Bounded", "Read this.")
	for _, name := range []string{"x\\SKILL.md", "x/\x7fSKILL.md", strings.Repeat("x", 513)} {
		if _, err := readZIP(t.Context(), testZIP(t, map[string][]byte{name: manifest}, 0o600)); err == nil {
			t.Fatal("unsafe archive header accepted")
		}
	}
	if _, err := readZIP(t.Context(), make([]byte, ArchiveBytes+1)); err == nil {
		t.Fatal("oversized raw archive accepted")
	}
	for _, count := range []int{SupportFileLimit + 1, TreeEntryLimit + 1} {
		entries := map[string][]byte{"SKILL.md": manifest}
		for index := range count {
			entries[fmt.Sprintf("assets/%04d", index)] = nil
		}
		_, err := readZIP(t.Context(), testZIP(t, entries, 0o600))
		assertSkillFailureCode(t, err, "size_limit")
	}
	_, err := readZIP(t.Context(), testZIP(t, map[string][]byte{"SKILL.md": manifest, "assets/large": make([]byte, FileBytes+1)}, 0o600))
	assertSkillFailureCode(t, err, "size_limit")

	var compressed bytes.Buffer
	writer := zip.NewWriter(&compressed)
	for _, name := range []string{"SKILL.md", "assets/a", "assets/b"} {
		entry, err := writer.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(make([]byte, FileBytes)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = readZIP(t.Context(), compressed.Bytes())
	assertSkillFailureCode(t, err, "size_limit")

	data := testZIP(t, map[string][]byte{"SKILL.md": manifest}, 0o600)
	central := bytes.Index(data, []byte{'P', 'K', 1, 2})
	if central < 0 {
		t.Fatal("missing synthetic ZIP central directory")
	}
	binary.LittleEndian.PutUint16(data[8:10], 99)
	binary.LittleEndian.PutUint16(data[central+10:central+12], 99)
	if _, err := readZIP(t.Context(), data); err == nil {
		t.Fatal("unsupported compression algorithm accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := readZIP(ctx, testZIP(t, map[string][]byte{"SKILL.md": manifest}, 0o600)); err != context.Canceled {
		t.Fatal("cancelled archive inspection continued", err)
	}
}

func TestSkillExportRejectsChangedMetadataAndCancellationBeforeZIPWrites(t *testing.T) {
	for _, scenario := range []string{"control-metadata", "credential-metadata", "cancelled-metadata"} {
		t.Run(scenario, func(t *testing.T) {
			library := makeLibrary(t)
			input := skillInput()
			if _, err := library.Save(t.Context(), input, true); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if scenario == "control-metadata" {
				meta := Metadata{Owner: "dant", Name: input.Name, Description: "unsafe\x01description", UpdatedAt: 1}
				if err := os.WriteFile(filepath.Join(library.enabledRoot, input.Name, markerName), jsonBytes(meta), 0o600); err != nil {
					t.Fatal(err)
				}
			} else {
				library.containsSecret = func(_ context.Context, value string) bool {
					if value == input.Description {
						if scenario == "cancelled-metadata" {
							cancel()
							return false
						}
						return true
					}
					return false
				}
			}
			data, err := library.ExportZIP(ctx, input.Name)
			if err == nil || len(data) != 0 {
				t.Fatal("failed export leaked archive bytes")
			}
		})
	}
}
