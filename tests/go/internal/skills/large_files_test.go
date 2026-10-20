package skills

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func largeSkillInput() SaveInput {
	return SaveInput{Name: "portable-project", Description: "A portable project with preserved data.", Instructions: "Review helpers; management must never execute them.", Files: map[string]string{}}
}

func writeLargeSkillFiles(t *testing.T, directory string, content map[string][]byte) map[string][32]byte {
	t.Helper()
	hashes := map[string][32]byte{}
	for relative, data := range content {
		path := filepath.Join(directory, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		hashes[relative] = sha256.Sum256(data)
	}
	return hashes
}

func assertLargeSkillHashes(t *testing.T, directory string, want map[string][32]byte) {
	t.Helper()
	for relative, hash := range want {
		data, err := os.ReadFile(filepath.Join(directory, filepath.FromSlash(relative)))
		if err != nil || sha256.Sum256(data) != hash {
			t.Fatalf("support bytes changed: %s", relative)
		}
	}
}

func assertSkillFailureCode(t *testing.T, err error, code string) {
	t.Helper()
	var failure *contracts.APIError
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("skill failure category=%v; wanted=%s", err, code)
	}
}

func TestIndependentlyGrown81FileProjectPreservesPNGAndUTF8ThroughEditToggleAndImport(t *testing.T) {
	library := makeLibrary(t)
	input := largeSkillInput()
	saved, err := library.Save(t.Context(), input, true)
	if err != nil {
		t.Fatal(err)
	}
	content := map[string][]byte{
		"assets/large.png":          append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, bytes.Repeat([]byte{255}, 1557774-8)...),
		"assets/second.png":         bytes.Repeat([]byte{255}, 500000),
		"references/large-utf8.txt": []byte("\ufeff" + strings.Repeat("原文保持\r\n", 50000)),
	}
	for index := range 78 {
		content[fmt.Sprintf("scripts/source-%02d.py", index)] = []byte("# Never execute during management\r\n" + strings.Repeat("x", 13265))
	}
	total := 0
	for _, data := range content {
		total += len(data)
	}
	if len(content) != 81 || total < 3700000 || total > 3900000 {
		t.Fatal("fixture is not the independently grown 3.8MB project")
	}
	directory := filepath.Dir(saved.Path)
	want := writeLargeSkillFiles(t, directory, content)
	marker, err := os.ReadFile(filepath.Join(directory, markerName))
	if err != nil {
		t.Fatal(err)
	}
	view, err := library.Get(t.Context(), input.Name)
	if err != nil || len(view.Files) != 78 || len(view.Assets) != 3 || view.Files["references/large-utf8.txt"] != "" {
		t.Fatal("large project editor projection lost its read-only asset boundary", err)
	}
	if len(jsonBytes(struct {
		Instructions string            `json:"instructions"`
		Files        map[string]string `json:"files"`
	}{view.Instructions, view.Files})) > EditorJSONBytes {
		t.Fatal("projected editor response exceeded encoded JSON budget")
	}
	after, err := os.ReadFile(filepath.Join(directory, markerName))
	if err != nil || !bytes.Equal(marker, after) {
		t.Fatal("reading independently grown skill rewrote its managed marker")
	}
	input.Files = view.Files
	input.Files["scripts/source-00.py"] = "# Changed only this helper\r\n"
	input.PreserveBinaryFiles = true
	edited, err := library.Save(t.Context(), input, true)
	if err != nil {
		t.Fatal(err)
	}
	want["scripts/source-00.py"] = sha256.Sum256([]byte(input.Files["scripts/source-00.py"]))
	assertLargeSkillHashes(t, filepath.Dir(edited.Path), want)
	input.Files["references/large-utf8.txt"] = "must not overwrite read-only asset"
	if _, err := library.Save(t.Context(), input, true); err == nil {
		t.Fatal("editor replaced a preserved large asset")
	}
	assertLargeSkillHashes(t, filepath.Dir(edited.Path), want)
	for _, enabled := range []bool{false, true} {
		toggled, err := library.SetEnabled(t.Context(), input.Name, enabled)
		if err != nil || toggled.Enabled != enabled {
			t.Fatal("large skill toggle failed", err)
		}
		assertLargeSkillHashes(t, filepath.Dir(toggled.Path), want)
	}
	archive, err := library.ExportZIP(t.Context(), input.Name)
	if err != nil {
		t.Fatal(err)
	}
	destination := makeLibrary(t)
	importer := NewImporter(t.Context(), destination, nil, nil)
	defer importer.Close()
	preview, err := importer.Preview(t.Context(), ImportInput{Name: "project.zip", Data: archive})
	if err != nil || len(preview.Files) != 82 {
		t.Fatal("large portable project preview lost files", err)
	}
	imported, err := importer.Commit(t.Context(), preview.ID, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	assertLargeSkillHashes(t, filepath.Dir(imported.Path), want)
	snapshot, err := destination.ExportSnapshot(t.Context(), imported.Name)
	if err != nil || snapshot.Files["references/large-utf8.txt"] != string(content["references/large-utf8.txt"]) {
		t.Fatal("UTF-8 BOM or CRLF bytes changed across portable import")
	}
	input.Files = map[string]string{}
	input.PreserveBinaryFiles = false
	replaced, err := library.Save(t.Context(), input, true)
	if err != nil || len(replaced.Assets) != 0 {
		t.Fatal("explicit non-preserving replacement retained removed assets", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(replaced.Path), "references", "large-utf8.txt")); !os.IsNotExist(err) {
		t.Fatal("explicitly removed large asset remained on disk")
	}
}

func TestEditorAggregateAndEscapedJSONLimitsPreserveOmittedSmallFiles(t *testing.T) {
	library := makeLibrary(t)
	input := largeSkillInput()
	for index := range 6 {
		input.Files[fmt.Sprintf("references/file-%d.txt", index)] = strings.Repeat("\\", 220*1024)
	}
	saved, err := library.Save(t.Context(), input, true)
	if err != nil {
		t.Fatal(err)
	}
	total := len(saved.Instructions)
	for _, text := range saved.Files {
		if len(text) > EditorFileBytes {
			t.Fatal("oversized file entered editor")
		}
		total += len(text)
	}
	if total > EditorTotalBytes || len(saved.Assets) == 0 {
		t.Fatal("editor raw aggregate budget was not enforced")
	}
	preserved := map[string][32]byte{}
	for _, asset := range saved.Assets {
		preserved[asset.Path] = sha256.Sum256([]byte(input.Files[asset.Path]))
	}
	input.Files = map[string]string{}
	input.PreserveBinaryFiles = true
	result, err := library.Save(t.Context(), input, true)
	if err != nil {
		t.Fatal(err)
	}
	assertLargeSkillHashes(t, filepath.Dir(result.Path), preserved)
	for relative := range saved.Files {
		if _, err := os.Stat(filepath.Join(filepath.Dir(result.Path), filepath.FromSlash(relative))); !os.IsNotExist(err) {
			t.Fatal("removed editable file was silently retained")
		}
	}
	input.Instructions = "i"
	input.PreserveBinaryFiles = false
	for index := range 4 {
		length := EditorFileBytes
		if index == 3 {
			length--
		}
		input.Files[fmt.Sprintf("references/escaped-%d.txt", index)] = strings.Repeat("\\", length)
	}
	view, err := library.Save(t.Context(), input, true)
	if err != nil || len(view.Files) != 3 || len(view.Assets) != 1 {
		t.Fatal("encoded property/escaping overhead did not exclude final editor file", err)
	}
	want := map[string][32]byte{}
	for name, data := range input.Files {
		want[name] = sha256.Sum256([]byte(data))
	}
	input.Files = view.Files
	input.PreserveBinaryFiles = true
	view, err = library.Save(t.Context(), input, true)
	if err != nil {
		t.Fatal(err)
	}
	assertLargeSkillHashes(t, filepath.Dir(view.Path), want)
	archive, err := library.ExportZIP(t.Context(), input.Name)
	if err != nil {
		t.Fatal(err)
	}
	destination := makeLibrary(t)
	importer := NewImporter(t.Context(), destination, nil, nil)
	defer importer.Close()
	preview, err := importer.Preview(t.Context(), ImportInput{Name: "escaped.zip", Data: archive})
	if err != nil {
		t.Fatal(err)
	}
	imported, err := importer.Commit(t.Context(), preview.ID, "", nil)
	if err != nil || len(imported.Assets) != 1 {
		t.Fatal("portable import changed editor JSON projection", err)
	}
	assertLargeSkillHashes(t, filepath.Dir(imported.Path), want)
}

func TestEightMiBOpaqueAndNineMiBAggregateLimitsNeverReplaceExistingOnFailure(t *testing.T) {
	library := makeLibrary(t)
	input := largeSkillInput()
	input.Instructions = "i"
	data := bytes.Repeat([]byte{255}, FileBytes)
	decoded, err := decodeBinary(binaryValue(data))
	if err != nil || !bytes.Equal(decoded, data) {
		t.Fatal("8MiB opaque file did not retain canonical base64 bytes")
	}
	input.BinaryFiles = map[string]BinaryFile{"assets/full.bin": binaryValue(data)}
	saved, err := library.Save(t.Context(), input, true)
	if err != nil || len(saved.Assets) != 1 || saved.Assets[0].Size != FileBytes {
		t.Fatal("8MiB asset was not accepted", err)
	}
	want := map[string][32]byte{"assets/full.bin": sha256.Sum256(data)}
	for _, change := range []func(*SaveInput){
		func(value *SaveInput) {
			value.Files = map[string]string{"assets/too-large.txt": strings.Repeat("x", FileBytes+1)}
		},
		func(value *SaveInput) {
			value.BinaryFiles = map[string]BinaryFile{"assets/full.bin": binaryValue(data), "assets/overflow.bin": binaryValue(bytes.Repeat([]byte{255}, TotalBytes-FileBytes))}
		},
	} {
		invalid := largeSkillInput()
		invalid.Instructions = "i"
		change(&invalid)
		_, err := library.Save(t.Context(), invalid, true)
		assertSkillFailureCode(t, err, "size_limit")
		assertLargeSkillHashes(t, filepath.Dir(saved.Path), want)
	}
	input.BinaryFiles["assets/remainder.bin"] = binaryValue(bytes.Repeat([]byte{255}, TotalBytes-FileBytes-1))
	saved, err = library.Save(t.Context(), input, true)
	if err != nil || len(saved.Assets) != 2 {
		t.Fatal("exact 9MiB support+instruction aggregate was rejected", err)
	}
	archive, err := library.ExportZIP(t.Context(), input.Name)
	if err != nil || len(archive) <= TotalBytes || len(archive) > ArchiveBytes {
		t.Fatal("maximum ZIP exceeded 10MiB envelope or lost its original bytes", err)
	}
}

func TestCredentialScanningCoversLargeUTF8UTF16AndOpaqueTailWithoutMutatingFiles(t *testing.T) {
	secret := "synthetic-secret-value"
	units := utf16.Encode([]rune(strings.Repeat("x", 400000) + secret))
	utf16Data := make([]byte, 2+len(units)*2)
	utf16Data[0], utf16Data[1] = 255, 254
	for index, unit := range units {
		binary.LittleEndian.PutUint16(utf16Data[2+index*2:], unit)
	}
	for _, data := range [][]byte{[]byte(strings.Repeat("x", 700000) + secret), append(bytes.Repeat([]byte{255}, 1557774), []byte(secret)...), utf16Data} {
		library := makeLibrary(t)
		input := largeSkillInput()
		saved, err := library.Save(t.Context(), input, true)
		if err != nil {
			t.Fatal(err)
		}
		want := writeLargeSkillFiles(t, filepath.Dir(saved.Path), map[string][]byte{"assets/private.resource": data})
		_, err = library.Get(t.Context(), input.Name)
		assertSkillFailureCode(t, err, "credentials")
		_, err = library.ExportZIP(t.Context(), input.Name)
		assertSkillFailureCode(t, err, "credentials")
		assertLargeSkillHashes(t, filepath.Dir(saved.Path), want)
		destination := makeLibrary(t)
		importer := NewImporter(t.Context(), destination, nil, nil)
		archive := testZIP(t, map[string][]byte{"project/SKILL.md": manifestBytes(input.Name, input.Description, input.Instructions), "project/assets/private.resource": data}, 0600)
		_, err = importer.Preview(t.Context(), ImportInput{Name: "private.zip", Data: archive})
		assertSkillFailureCode(t, err, "credentials")
		importer.Close()
		items, err := destination.List(context.Background())
		if err != nil || len(items) != 0 {
			t.Fatal("credential-bearing import mutated destination")
		}
	}
}
