package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func makeLibrary(t *testing.T) *Library {
	t.Helper()
	library, err := New(t.TempDir(), Options{Now: func() time.Time { return time.UnixMilli(1234) }, ContainsSecret: func(_ context.Context, value string) bool { return strings.Contains(value, "synthetic-secret-value") }})
	if err != nil {
		t.Fatal(err)
	}
	return library
}

func binaryValue(data []byte) BinaryFile {
	return BinaryFile{Encoding: "base64", MediaType: "application/octet-stream", Data: base64.StdEncoding.EncodeToString(data)}
}

func skillInput() SaveInput {
	return SaveInput{Name: "test-skill", Description: "Test skill", Instructions: "Read the local reference when needed.", Files: map[string]string{"references/test.txt": "original text"}, BinaryFiles: map[string]BinaryFile{"assets/file.weird": binaryValue([]byte{0, 255, 128, 17, 0})}}
}

func TestSkillBinaryZIPRoundTripAndEditorPreservation(t *testing.T) {
	library := makeLibrary(t)
	input := skillInput()
	large := strings.Repeat("x", EditorFileBytes+1)
	input.Files["references/large.txt"] = large
	saved, err := library.Save(t.Context(), input, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Assets) != 2 || saved.Files["references/large.txt"] != "" {
		t.Fatalf("editor assets: %+v", saved.Assets)
	}
	data, err := library.ExportZIP(t.Context(), input.Name)
	if err != nil {
		t.Fatal(err)
	}
	imported := makeLibrary(t)
	importer := NewImporter(t.Context(), imported, nil, nil)
	defer importer.Close()
	preview, err := importer.Preview(t.Context(), ImportInput{Name: "test.zip", Data: data})
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.Files) != 4 {
		t.Fatalf("preview files: %+v", preview.Files)
	}
	result, err := importer.Commit(t.Context(), preview.ID, "", nil)
	if err != nil || result.Name != input.Name {
		t.Fatalf("import: %+v %v", result, err)
	}
	snapshot, err := imported.ExportSnapshot(t.Context(), input.Name)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := decodeBinary(snapshot.BinaryFiles["assets/file.weird"])
	if err != nil || !bytes.Equal(actual, []byte{0, 255, 128, 17, 0}) || snapshot.Files["references/large.txt"] != large {
		t.Fatal("import changed opaque file bytes")
	}
	edited, err := imported.Save(t.Context(), SaveInput{Name: result.Name, Description: "Edited", Instructions: "Edited instructions", Files: map[string]string{"references/test.txt": "changed"}, PreserveBinaryFiles: true}, true)
	if err != nil {
		t.Fatal(err)
	}
	if edited.Description != "Edited" {
		t.Fatal("edit not applied")
	}
	preserved, err := imported.ExportSnapshot(t.Context(), input.Name)
	if err != nil || preserved.BinaryFiles["assets/file.weird"] != snapshot.BinaryFiles["assets/file.weird"] || preserved.Files["references/large.txt"] != large {
		t.Fatalf("preserved asset lost: %v", err)
	}
	if _, err := importer.Commit(t.Context(), preview.ID, "", nil); err == nil {
		t.Fatal("preview replay accepted")
	}
	enabled, err := imported.SetEnabled(t.Context(), input.Name, false)
	if err != nil || enabled.Enabled {
		t.Fatalf("disable: %v", err)
	}
	index, err := imported.Context(t.Context())
	if err != nil || strings.Contains(index, "Test skill") {
		t.Fatalf("disabled skill in context: %q %v", index, err)
	}
	if err := imported.Remove(t.Context(), input.Name); err != nil {
		t.Fatal(err)
	}
	items, err := imported.List(t.Context())
	if err != nil || len(items) != 0 {
		t.Fatalf("remove: %+v %v", items, err)
	}
}

func TestSkillFailureDoesNotReplaceExistingContent(t *testing.T) {
	library := makeLibrary(t)
	input := skillInput()
	if _, err := library.Save(t.Context(), input, true); err != nil {
		t.Fatal(err)
	}
	cases := []SaveInput{
		{Name: input.Name, Description: "x", Instructions: "x", Files: map[string]string{"../outside": "bad"}},
		{Name: input.Name, Description: "x", Instructions: "x", Files: map[string]string{"assets/x": "one", "assets/X": "two"}},
		{Name: input.Name, Description: "x", Instructions: "x", Files: map[string]string{"assets/x": "one", "assets/x/nested": "two"}},
		{Name: input.Name, Description: "x", Instructions: "x", Files: map[string]string{"references/key.txt": "synthetic-secret-value"}},
		{Name: input.Name, Description: "x", Instructions: "x", BinaryFiles: map[string]BinaryFile{"assets/x": {Encoding: "base64", MediaType: "application/octet-stream", Data: "AB=="}}},
		{Name: input.Name, Description: "x", Instructions: "x", BinaryFiles: map[string]BinaryFile{"assets/x": binaryValue([]byte{0xff, 0xfe, 's', 0, 'y', 0, 'n', 0, 't', 0, 'h', 0, 'e', 0, 't', 0, 'i', 0, 'c', 0, '-', 0, 's', 0, 'e', 0, 'c', 0, 'r', 0, 'e', 0, 't', 0, '-', 0, 'v', 0, 'a', 0, 'l', 0, 'u', 0, 'e', 0})}},
	}
	for index, invalidInput := range cases {
		if _, err := library.Save(t.Context(), invalidInput, true); err == nil {
			t.Fatalf("case %d accepted", index)
		}
		snapshot, err := library.ExportSnapshot(t.Context(), input.Name)
		if err != nil || snapshot.Files["references/test.txt"] != "original text" {
			t.Fatalf("case %d changed existing: %v", index, err)
		}
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := library.Save(cancelled, input, true); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled save: %v", err)
	}
	entries, err := os.ReadDir(library.enabledRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			t.Fatalf("staging leaked: %q", entry.Name())
		}
	}
}

func TestSkillExportRejectsLinkedFilesAndUnmanagedFolders(t *testing.T) {
	library := makeLibrary(t)
	input := skillInput()
	saved, err := library.Save(t.Context(), input, true)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(filepath.Dir(saved.Path), "references", "test.txt")
	if err := os.Link(target, filepath.Join(filepath.Dir(saved.Path), "references", "linked.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := library.ExportZIP(t.Context(), input.Name); err == nil {
		t.Fatal("hard-linked support exported")
	}
	foreign := filepath.Join(library.enabledRoot, "foreign")
	if err := os.Mkdir(foreign, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := library.Save(t.Context(), SaveInput{Name: "foreign", Description: "x", Instructions: "x"}, true); err == nil {
		t.Fatal("unmanaged directory overwritten")
	}
}

func testZIP(t *testing.T, entries map[string][]byte, mode os.FileMode) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, name := range sortedNames(entries) {
		header := &zip.FileHeader{Name: name, Method: zip.Store}
		header.SetMode(mode)
		file, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(entries[name]); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestSkillZIPRejectsTraversalDuplicatesLinksAndCorruption(t *testing.T) {
	manifest := manifestBytes("test", "Test", "Read this.")
	for _, entries := range []map[string][]byte{
		{"../SKILL.md": manifest},
		{"a/SKILL.md": manifest, "b/SKILL.md": manifest},
		{"x/SKILL.md": manifest, "x/assets/a": {}, "x/assets/A": {}},
		{"x/SKILL.md": manifest, "x/assets/a": {}, "x/assets/a/child": {}},
		{"x/SKILL.md": manifest, "x/config.env": {}},
	} {
		if _, err := readZIP(t.Context(), testZIP(t, entries, 0o600)); err == nil {
			t.Fatalf("unsafe archive accepted: %v", sortedNames(entries))
		}
	}
	if _, err := readZIP(t.Context(), testZIP(t, map[string][]byte{"x/SKILL.md": manifest}, os.ModeSymlink|0o777)); err == nil {
		t.Fatal("symlink accepted")
	}
	data := testZIP(t, map[string][]byte{"x/SKILL.md": manifest}, 0o600)
	offset := bytes.Index(data, manifest)
	if offset < 0 {
		t.Fatal("fixture missing bytes")
	}
	data[offset] ^= 1
	if _, err := readZIP(t.Context(), data); err == nil {
		t.Fatal("corrupt CRC accepted")
	}
}

func TestSkillImportPreviewLimitExpiryAndNameConflict(t *testing.T) {
	library := makeLibrary(t)
	now := time.Unix(0, 0)
	importer := NewImporter(t.Context(), library, nil, func() time.Time { return now })
	defer importer.Close()
	input := ImportInput{Name: "SKILL.md", Data: manifestBytes("test", "Test", "Read this.")}
	var previews []Preview
	for index := 0; index < MaxPreviews; index++ {
		preview, err := importer.Preview(t.Context(), input)
		if err != nil {
			t.Fatal(err)
		}
		previews = append(previews, preview)
	}
	if _, err := importer.Preview(t.Context(), input); err == nil {
		t.Fatal("unbounded previews")
	}
	if items, err := library.List(t.Context()); err != nil || len(items) != 0 {
		t.Fatal("preview wrote skill files")
	}
	if _, err := importer.Commit(t.Context(), previews[0].ID, "", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := importer.Commit(t.Context(), previews[1].ID, "", nil); err == nil {
		t.Fatal("existing skill overwritten")
	}
	now = now.Add(PreviewLifetime)
	if _, err := importer.Commit(t.Context(), previews[2].ID, "renamed", nil); err == nil {
		t.Fatal("expired preview committed")
	}
}

func TestSkillManifestRestrictedMetadata(t *testing.T) {
	source := []byte("---\nname: test\ndescription: >-\n  First line\n  second line\nlicense: 'MIT'\nmetadata:\n  author: sample\n---\n\nRead reference.\n")
	candidate, err := parseManifest(source, "https://github.com/owner/repo/tree/commit")
	if err != nil || candidate.Description != "First line second line" || !strings.Contains(candidate.Instructions, "License: MIT") {
		t.Fatalf("manifest: %+v %v", candidate, err)
	}
	for _, value := range []string{"---\nname: test\nname: twice\ndescription: x\n---\nx", "---\nname: test\ndescription: x\nallowed-tools: all\n---\nx", "---\nname: test\ndescription: &anchor unsafe\n---\nx"} {
		if _, err := parseManifest([]byte(value), ""); err == nil {
			t.Fatal("unsafe metadata accepted")
		}
	}
	decoded, err := DecodeSave([]byte(`{"name":"test","description":"x","instructions":"x","files":null}`))
	if err == nil || decoded.Name != "" {
		t.Fatal("null replacement accepted")
	}
	var api *contracts.APIError
	if !errors.As(invalid(), &api) {
		t.Fatal("typed error missing")
	}
}
