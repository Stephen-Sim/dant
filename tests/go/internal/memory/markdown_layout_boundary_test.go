package memory

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMarkdownImportRejectsADirectoryAndRetainsItsSQLAndSnapshotSources(t *testing.T) {
	s := openStoreFixture(t)
	if err := s.WriteNote(t.Context(), "identity.md", "Synthetic retained SQLite identity"); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(s.Directory(), "identity.md")
	before, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	retained := filepath.Join(t.TempDir(), "original.md")
	if err := os.Rename(file, retained); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(file, 0700); err != nil {
		t.Fatal(err)
	}
	importErr := s.ImportMarkdown(t.Context(), "identity.md")
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(retained, file); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(importErr, ErrInvalidMemory) {
		t.Fatal("directory snapshot path was imported as a note", importErr)
	}
	text, sqlErr := s.ReadNote(t.Context(), "identity.md")
	after, readErr := os.ReadFile(file)
	if sqlErr != nil || readErr != nil || text != "Synthetic retained SQLite identity" || !bytes.Equal(before, after) {
		t.Fatal("failed import changed either canonical SQL or the retained original snapshot", sqlErr, readErr)
	}
}
