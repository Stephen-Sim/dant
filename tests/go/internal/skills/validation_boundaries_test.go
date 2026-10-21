package skills

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"
	"unicode/utf16"
)

func TestSkillManifestScalarsPreserveTextAndRejectExecutableYAMLForms(t *testing.T) {
	for _, item := range []struct{ scalar, want string }{
		{`"quoted text" # comment`, "quoted text"},
		{`'it''s a skill' # comment`, "it's a skill"},
		{"plain text # comment", "plain text"},
	} {
		actual, err := scalar(item.scalar)
		if err != nil || actual != item.want {
			t.Fatal("restricted scalar changed literal text", err)
		}
	}
	for _, value := range []string{`"unterminated`, `"\ud800"`, `"\xinvalid"`, `'unterminated`, "", "*alias", "!execute", "&anchor value", "[sequence]", "text &anchor"} {
		if _, err := scalar(value); err == nil {
			t.Fatal("unsupported scalar accepted")
		}
	}
	for _, item := range []struct{ description, want string }{
		{"|\n  first\n\n  second", "first\n\nsecond"},
		{">-\n  first\n\n  second\n  third", "first\n\nsecond third"},
	} {
		manifest := "---\n# comment\n\nname: scalar-test\ndescription: " + item.description + "\ncompatibility: 'Local VM only'\n---\nRead this."
		result, err := parseManifest([]byte(manifest), "fixture.zip")
		if err != nil || result.Description != item.want || !strings.Contains(result.Instructions, "Compatibility: Local VM only") {
			t.Fatal("block scalar or compatibility text changed", err)
		}
	}
	for _, value := range []string{
		"not frontmatter", "---\nname: test", "---\n" + strings.Repeat("#", 8193) + "\n---\nx",
		"---\nname: test\ndescription: |\n\tbad indentation\n---\nx", "---\nname: test\ndescription: |\n\n---\nx",
		"---\nname: test\ndescription: ok\n---\n", "---\nname: test\ndescription: ok\n---\n" + strings.Repeat("x", InstructionBytes+1),
		"---\nname: test\ndescription: " + strings.Repeat("x", DescriptionBytes+1) + "\n---\nx",
		"---\nname: test\ndescription: ok\n---\n\x00", string([]byte{0xff}),
	} {
		if _, err := parseManifest([]byte(value), ""); err == nil {
			t.Fatal("malformed manifest accepted")
		}
	}
}

func TestSkillBinaryClassificationAndCanonicalEncoding(t *testing.T) {
	for _, value := range []string{"%PDF-1.7", "MZ", "PK\x03\x04", "RIFF", "OggS", "GIF87a", "GIF89a"} {
		if textFile([]byte(value)) || !binarySignature([]byte(value)) {
			t.Fatal("binary container was exposed as editable text")
		}
	}
	for _, value := range []string{"assets/../bad", "assets/a:b", "assets/\x7f", "assets//bad", "assets/" + string([]byte{0xff}), "unsupported.txt"} {
		if ValidFileName(value) {
			t.Fatal("invalid support path accepted")
		}
	}
	for _, value := range []BinaryFile{
		{Encoding: "hex", MediaType: "application/octet-stream", Data: "00"},
		{Encoding: "base64", MediaType: "image/png", Data: "AA=="},
		{Encoding: "base64", MediaType: "application/octet-stream", Data: "AA==\n"},
		{Encoding: "base64", MediaType: "application/octet-stream", Data: "!invalid"},
		{Encoding: "base64", MediaType: "application/octet-stream", Data: base64.StdEncoding.EncodeToString(make([]byte, FileBytes+1))},
	} {
		if _, err := decodeBinary(value); err == nil {
			t.Fatal("noncanonical or oversized binary accepted")
		}
	}
	withoutScanner, err := New(t.TempDir(), Options{})
	if err != nil || withoutScanner.secret(t.Context(), []byte("public text")) {
		t.Fatal("optional secret scanner changed content", err)
	}
	library := makeLibrary(t)
	units := utf16.Encode([]rune("synthetic-secret-value"))
	encoded := make([]byte, 2+2*len(units)+1)
	encoded[0], encoded[1] = 254, 255
	for index, unit := range units {
		binary.BigEndian.PutUint16(encoded[2+index*2:], unit)
	}
	if !library.secret(t.Context(), encoded) {
		t.Fatal("big endian UTF-16 credential escaped scanning")
	}
}

func TestSkillImporterRejectsInvalidLocalSourcesAndRetainsOneShotFailures(t *testing.T) {
	library := makeLibrary(t)
	importer := NewImporter(t.Context(), library, nil, nil)
	defer importer.Close()
	manifest := manifestBytes("candidate", "Candidate", "Read this.")
	for _, input := range []ImportInput{
		{}, {URL: "https://github.com/a/b", Data: []byte{}},
		{Name: "unknown.txt", Data: manifest}, {Name: "bad\x7f.zip", Data: manifest},
		{Name: strings.Repeat("x", RelativePathCharacters+1), Data: manifest},
		{Name: "x.zip", Data: make([]byte, ArchiveBytes+1)},
		{Name: "SKILL.md", Data: make([]byte, FileBytes+1)},
		{Name: "SKILL.md", Data: []byte("malformed")},
		{Name: "x.zip", Data: []byte("not a ZIP")},
		{Name: "SKILL.md", Data: manifestBytes("synthetic-secret-value", "Secret", "Read this.")},
	} {
		if _, err := importer.Preview(t.Context(), input); err == nil {
			t.Fatal("invalid local source created a preview")
		}
	}
	preview, err := importer.Preview(t.Context(), ImportInput{Name: "SKILL.md", Data: manifest})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := importer.Commit(t.Context(), preview.ID, "invalid!", nil); err == nil {
		t.Fatal("invalid rename accepted")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := importer.Commit(cancelled, preview.ID, "", nil); err == nil {
		t.Fatal("cancelled save unexpectedly committed")
	}
	if _, err := importer.Commit(t.Context(), preview.ID, "", nil); err == nil {
		t.Fatal("failed save preview replayed")
	}
	if _, err := (guardedReader{ctx: cancelled, reader: strings.NewReader("content")}).Read(make([]byte, 2)); !errors.Is(err, context.Canceled) {
		t.Fatal("archive reader ignored cancellation")
	}
	if err := importer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := importer.Preview(t.Context(), ImportInput{Name: "SKILL.md", Data: manifest}); err == nil {
		t.Fatal("closed importer admitted a new preview")
	}
}

func TestSkillSaveRejectsIncompatiblePreservationDuplicateFilesAndOversizedInventories(t *testing.T) {
	for _, scenario := range []string{"preserve-missing", "preserve-binary", "duplicate", "count", "secret", "unreadable-preserved", "root-file"} {
		t.Run(scenario, func(t *testing.T) {
			library := makeLibrary(t)
			input := skillInput()
			if scenario != "preserve-missing" && scenario != "root-file" {
				if _, err := library.Save(t.Context(), input, true); err != nil {
					t.Fatal(err)
				}
			}
			switch scenario {
			case "preserve-missing":
				input.PreserveBinaryFiles = true
				input.BinaryFiles = nil
			case "preserve-binary":
				input.PreserveBinaryFiles = true
			case "duplicate":
				input.Files["assets/file.weird"] = "conflicting text"
			case "count":
				input.BinaryFiles = nil
				for index := range SupportFileLimit + 1 {
					input.Files[fmt.Sprintf("assets/%03d", index)] = "x"
				}
			case "secret":
				input.Description = "synthetic-secret-value"
			case "unreadable-preserved":
				if err := os.Remove(filepath.Join(library.enabledRoot, input.Name, "SKILL.md")); err != nil {
					t.Fatal(err)
				}
				input.Files = nil
			case "root-file":
				if err := os.MkdirAll(filepath.Dir(library.enabledRoot), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(library.enabledRoot, []byte("blocked directory"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := library.Save(t.Context(), input, true); err == nil {
				t.Fatal("invalid preservation or persisted state accepted")
			}
		})
	}
	for _, input := range []string{"{", `{"name":"test","description":"x","instructions":"x","files":3}`} {
		if _, err := DecodeSave([]byte(input)); err == nil {
			t.Fatal("invalid typed save body accepted")
		}
	}
	asset := `{"encoding":"base64","mediaType":"application/octet-stream","data":"AA=="}`
	duplicate := `{"name":"test","description":"x","instructions":"x","binaryFiles":{"assets/a":` + asset + `,"assets/a":` + asset + `}}`
	if _, err := DecodeSave([]byte(duplicate)); err == nil {
		t.Fatal("duplicate binary asset identity accepted")
	}
}

func TestSkillPreviewCancellationAndClosingJoinTheOwnedPreview(t *testing.T) {
	library := makeLibrary(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	library.containsSecret = func(_ context.Context, value string) bool {
		if value == "Read this." {
			cancel()
		}
		return false
	}
	importer := NewImporter(t.Context(), library, nil, nil)
	_, err := importer.Preview(ctx, ImportInput{Name: "SKILL.md", Data: manifestBytes("cancelled", "Cancelled", "Read this.")})
	if !errors.Is(err, context.Canceled) {
		t.Fatal("preview ignored cancellation before publishing its identity", err)
	}
	if err := importer.Close(); err != nil {
		t.Fatal(err)
	}

	synctest.Test(t, func(t *testing.T) {
		entered, release := make(chan struct{}), make(chan struct{})
		importer := NewImporter(t.Context(), makeLibrary(t), nil, func() time.Time {
			close(entered)
			<-release
			return time.Now()
		})
		previewDone, closeDone := make(chan error, 1), make(chan error, 1)
		go func() {
			_, err := importer.Preview(t.Context(), ImportInput{Name: "SKILL.md", Data: manifestBytes("closing", "Closing", "Read this.")})
			previewDone <- err
		}()
		<-entered
		go func() { closeDone <- importer.Close() }()
		synctest.Wait()
		select {
		case <-closeDone:
			t.Fatal("Close returned before its owned preview finished")
		default:
		}
		close(release)
		assertSkillFailureCode(t, <-previewDone, "expired")
		if err := <-closeDone; err != nil {
			t.Fatal(err)
		}
	})
}

func TestSkillPreviewRejectsAggregateSupportBytesBeforeCreatingPreview(t *testing.T) {
	library := makeLibrary(t)
	importer := NewImporter(t.Context(), library, nil, nil)
	defer importer.Close()
	data := testZIP(t, map[string][]byte{
		"SKILL.md": manifestBytes("large", "Large", "Read this."),
		"assets/a": make([]byte, TotalBytes/2),
		"assets/b": make([]byte, TotalBytes/2),
	}, 0o600)
	_, err := importer.Preview(t.Context(), ImportInput{Name: "large.zip", Data: data})
	assertSkillFailureCode(t, err, "size_limit")
	if len(importer.previews) != 0 {
		t.Fatal("oversized source published an import capability")
	}
}
