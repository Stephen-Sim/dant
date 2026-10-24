package runtime

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func privateConversationTemp(t *testing.T) string {
	t.Helper()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(key, parent)
	}
	return parent
}

func TestConversationDirectoryOwnsItsCreatedCanonicalRootAndFixedPolicy(t *testing.T) {
	parent := privateConversationTemp(t)
	directory, err := createConversationDirectory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { directory.remove() })
	if filepath.Dir(directory.path) != parent || !directory.current() {
		t.Fatal("fresh directory lost its created ownership or selected temporary parent")
	}
	if resolved, err := filepath.EvalSymlinks(directory.path); err != nil || resolved != directory.path {
		t.Fatal("namespace creator retained a noncanonical spelling")
	}
	if err := validateConversationRoot(directory.path); err != nil {
		t.Fatal("fresh namespace layout did not preserve its private-policy contract")
	}
	if !directory.remove() {
		t.Fatal("confirmed owned directory did not clean up")
	}
	if _, err := os.Stat(directory.path); !errors.Is(err, os.ErrNotExist) || directory.remove() {
		t.Fatal("cleanup did not remain scoped to the original directory")
	}
}

func TestConversationDirectoryIdentityCannotAdoptReplacementBeforeFirstComparison(t *testing.T) {
	parent := privateConversationTemp(t)
	root := filepath.Join(parent, "original")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	identity, err := captureConversationDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	// This replacement occurs before the first SameFile on retained identity.
	// A Windows path-only Lstat snapshot would lazily adopt the replacement.
	held := filepath.Join(parent, "retained-original")
	if err := os.Rename(root, held); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "foreign-marker")
	if err := os.WriteFile(marker, []byte("preserve this replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := canonicalConversationDirectory(root, identity); !errors.Is(err, ErrWorkerRole) {
		t.Fatal("canonical spelling adopted a different directory")
	}
	directory := &conversationDirectory{path: root, identity: identity}
	if directory.current() || directory.remove() {
		t.Fatal("a replacement was treated as the owned directory")
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "preserve this replacement" {
		t.Fatal("unconfirmed cleanup removed a replacement")
	}
	if _, err := os.Stat(held); err != nil {
		t.Fatal("the retained original was removed through a different path")
	}
}

func TestConversationDirectoryRejectsAbsentFilesAndMissingIdentity(t *testing.T) {
	parent := privateConversationTemp(t)
	file := filepath.Join(parent, "regular-file")
	if err := os.WriteFile(file, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{file, filepath.Join(parent, "missing")} {
		if _, err := captureConversationDirectory(path); !errors.Is(err, ErrWorkerRole) {
			t.Fatal("non-directory was accepted as owned")
		}
	}
	if _, err := canonicalConversationDirectory(parent, nil); !errors.Is(err, ErrWorkerRole) {
		t.Fatal("missing retained identity was accepted")
	}
	var absent *conversationDirectory
	if absent.current() || absent.remove() || (&conversationDirectory{path: parent}).current() {
		t.Fatal("missing ownership proof was treated as a removable directory")
	}
}

func TestConversationDirectoryUnavailableTemporaryParentFailsWithoutReplacingFiles(t *testing.T) {
	parent := privateConversationTemp(t)
	missing := filepath.Join(parent, "missing-parent")
	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(key, missing)
	}
	if _, err := createConversationDirectory(); !errors.Is(err, ErrDisconnected) {
		t.Fatal("unavailable temporary parent did not fail closed")
	}
	if _, err := os.Stat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("temporary setup replaced or fabricated the selected parent")
	}
}
