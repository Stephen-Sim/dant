package memory

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMarkdownLinkValidationRejectsMissingAndForeignFileIdentities(t *testing.T) {
	root := t.TempDir()
	first, second := filepath.Join(root, "first.md"), filepath.Join(root, "second.md")
	for _, file := range []string{first, second} {
		if err := os.WriteFile(file, []byte("Synthetic note"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	info, err := os.Lstat(first)
	if err != nil {
		t.Fatal(err)
	}
	if !oneLink(first, info) || oneLink(second, info) {
		t.Fatal("note link validation lost its actual file identity")
	}
	if err := os.Remove(first); err != nil {
		t.Fatal(err)
	}
	if oneLink(first, info) {
		t.Fatal("missing file retained a valid single-link identity")
	}
}
