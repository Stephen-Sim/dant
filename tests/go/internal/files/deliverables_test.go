package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestManagedRootBoundedIdentityReads(t *testing.T) {
	directory := t.TempDir()
	data := []byte{0, 255, 1, 128, 10}
	if err := os.WriteFile(filepath.Join(directory, "result.bin"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := OpenManagedRoot(directory, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	hash, size, err := root.Digest(t.Context(), "result.bin", 10)
	expected := sha256.Sum256(data)
	if err != nil || hash != hex.EncodeToString(expected[:]) || size != int64(len(data)) {
		t.Fatalf("digest: %q %d %v", hash, size, err)
	}
	if _, err := root.ReadFile(t.Context(), "result.bin", 4); !errors.Is(err, ErrFileLimit) {
		t.Fatalf("size: %v", err)
	}
	if _, err := root.ReadFile(t.Context(), "../result.bin", 10); !errors.Is(err, ErrManagedPath) {
		t.Fatalf("traversal: %v", err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := root.ReadFile(cancelled, "result.bin", 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	if err := os.Link(filepath.Join(directory, "result.bin"), filepath.Join(directory, "linked.bin")); err != nil {
		t.Fatal(err)
	}
	if _, err := root.ReadFile(t.Context(), "linked.bin", 10); err == nil {
		t.Fatal("hard link accepted")
	}
}

func TestManagedRootRejectsReplacedDirectory(t *testing.T) {
	parent := t.TempDir()
	directory := filepath.Join(parent, "output")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "result.txt"), []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := OpenManagedRoot(directory, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := os.Rename(directory, filepath.Join(parent, "original")); err != nil {
		t.Skipf("platform forbids rename of held directory: %v", err)
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "result.txt"), []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := root.ReadFile(t.Context(), "result.txt", 100); !errors.Is(err, ErrFileChanged) {
		t.Fatalf("replaced directory accepted: %v", err)
	}
}

func TestOutputReferenceBoundaries(t *testing.T) {
	root := filepath.Join(t.TempDir(), "output")
	for _, value := range []string{"../outside", ".env", "assets/auth.json", "id_rsa", "https://example.com/x", "a%252F..%252Fsecret?x", "%C0%AF", "file://remote/a", "a%00b", "a#b"} {
		if got, ok := OutputReference(root, value, true); ok {
			t.Errorf("accepted %q as %q", value, got)
		}
	}
	for _, value := range []string{"output/report.txt", "./output/report.txt", "report.txt", "<report.txt>", "report%2Etxt"} {
		if got, ok := OutputReference(root, value, true); !ok || got != "report.txt" {
			t.Errorf("rejected %q: %q", value, got)
		}
	}
	if got, ok := OutputReference(root, "report%252Etxt", true); !ok || got != "report%2Etxt" {
		t.Fatalf("double decoding: %q %v", got, ok)
	}
}

func TestDeliverablesChangedOnlyAndExplicitSurvivesScanLimit(t *testing.T) {
	output := t.TempDir()
	attachments, err := OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	collector := NewDeliverableCollector(attachments, nil)
	old := filepath.Join(output, "old.txt")
	if err := os.WriteFile(old, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	baseline, err := collector.CaptureBaseline(t.Context(), output)
	if err != nil {
		t.Fatal(err)
	}
	binary := []byte{0, 255, 17, 128}
	if err := os.WriteFile(filepath.Join(output, "new.bin"), binary, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(output, "credentials.json"), []byte("hidden"), 0o600); err != nil {
		t.Fatal(err)
	}
	delivered, err := collector.Archive(t.Context(), output, "", baseline)
	if err != nil || len(delivered) != 1 || delivered[0].Name != "new.bin" {
		t.Fatalf("changed delivery: %+v %v", delivered, err)
	}
	_, got, err := attachments.Read(t.Context(), delivered[0].ID)
	if err != nil || !bytes.Equal(got, binary) {
		t.Fatal("binary bytes changed")
	}
	for index := 0; index < MaxOutputEntries; index++ {
		if err := os.WriteFile(filepath.Join(output, fmt.Sprintf("f%04d.txt", index)), []byte{}, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	delivered, err = collector.Archive(t.Context(), output, "[old](old.txt)", baseline)
	if err != nil || len(delivered) != 1 || delivered[0].Name != "old.txt" {
		t.Fatalf("explicit lost on broad failure: %+v %v", delivered, err)
	}
	failed, err := collector.CaptureBaseline(t.Context(), output)
	var decoded OutputBaseline
	if err != nil || json.Unmarshal(failed, &decoded) != nil || decoded.Valid {
		t.Fatal("invalid baseline accepted")
	}
	delivered, err = collector.ArchiveExplicit(t.Context(), ArchiveInput{OutputDirectory: output, ExplicitPaths: []string{"new.bin"}, OnlyExplicit: true, IsCurrent: func() bool { return false }})
	if !errors.Is(err, context.Canceled) || len(delivered) != 0 {
		t.Fatal("stale owner delivered files")
	}
}
