package backups

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixtureArchive(content []byte) []byte {
	var output bytes.Buffer
	output.WriteString(ArchiveMagic + "\n")
	encoder := json.NewEncoder(&output)
	encoder.Encode(struct {
		Type string `json:"type"`
		Manifest
	}{"header", Manifest{SchemaVersion: 1, CreatedAt: 1000, AppVersion: "0.4.7-beta.12", SourceID: "isolated-fixture", Files: 1, Bytes: int64(len(content))}})
	encoder.Encode(struct {
		Type       string `json:"type"`
		Domain     string `json:"domain"`
		Path       string `json:"path"`
		Size       int    `json:"size"`
		Executable bool   `json:"executable"`
	}{"file", "data", "state.json", len(content), false})
	if len(content) > 0 {
		encoder.Encode(struct {
			Type string `json:"type"`
			Data string `json:"data"`
		}{"chunk", base64.StdEncoding.EncodeToString(content)})
	}
	sum := sha256.Sum256(content)
	encoder.Encode(struct {
		Type   string `json:"type"`
		SHA256 string `json:"sha256"`
	}{"end", hex.EncodeToString(sum[:])})
	encoder.Encode(struct {
		Type  string `json:"type"`
		Files int    `json:"files"`
		Bytes int    `json:"bytes"`
	}{"footer", 1, len(content)})
	return output.Bytes()
}

func TestArchiveRoundTripKeepsRawBytesAndRequiresCompleteAuthentication(t *testing.T) {
	content := []byte{'{', '}', 0, 0xff, '\n'}
	input := fixtureArchive(content)
	archive, err := ValidateArchive(context.Background(), bytes.NewReader(input), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(filepath.Join(archive.Directory, "data", "state.json"))
	if err != nil || !bytes.Equal(content, actual) {
		t.Fatal("raw bytes changed")
	}
	var output bytes.Buffer
	if err := WriteArchive(context.Background(), &output, archive); err != nil {
		t.Fatal(err)
	}

	if _, err := ValidateArchive(context.Background(), bytes.NewReader(output.Bytes()), t.TempDir()); err != nil {
		t.Fatal("re-encoded archive rejected")
	}

	if err := os.WriteFile(filepath.Join(archive.Directory, "data", "state.json"), []byte("same-size"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := WriteArchive(context.Background(), &bytes.Buffer{}, archive); !errors.Is(err, ErrSourceChanged) {
		t.Fatal("changed source emitted successful archive")
	}
}

func TestArchiveRejectsTruncationTraversalAndReusedStaging(t *testing.T) {
	valid := fixtureArchive([]byte("{}"))
	for _, input := range [][]byte{valid[:len(valid)-1], append(append([]byte{}, valid...), []byte("{}\n")...), bytes.Replace(valid, []byte(`"state.json"`), []byte(`"../state.json"`), 1), bytes.Replace(valid, []byte(`"data":"e30="`), []byte(`"data":"e31="`), 1)} {
		if _, err := ValidateArchive(context.Background(), bytes.NewReader(input), t.TempDir()); err == nil {
			t.Fatal("invalid archive accepted")
		}
	}
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "existing"), nil, 0600); err != nil {
		t.Fatal(err)
	}

	if _, err := ValidateArchive(context.Background(), bytes.NewReader(valid), directory); !errors.Is(err, ErrInvalid) {
		t.Fatal("nonempty live directory reused as staging")
	}
	for _, path := range []string{"../escape", "/absolute", `a\b`, "a:b", "a/CON.txt", "a/./b", "a//b", "a/end.", "a/end ", strings.Repeat("a", MaxArchivePathBytes+1)} {
		if ValidArchivePath(path) {
			t.Fatal("unsafe archive path accepted")
		}
	}
}
