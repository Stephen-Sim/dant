package memory

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMemoryStoreNeverAdoptsAReplacementForAnyRetainedDirectory(t *testing.T) {
	for index, name := range []string{"configured root", "memory root", "memory owner"} {
		t.Run(name, func(t *testing.T) {
			s := openStoreFixture(t)
			retained := s.directories[index]
			moved := filepath.Join(t.TempDir(), "retained-original")
			if err := os.Rename(retained.path, moved); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(retained.path, 0700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(retained.path, "replacement-marker.txt")
			if err := os.WriteFile(marker, []byte("Synthetic replacement content"), 0600); err != nil {
				t.Fatal(err)
			}

			if _, err := s.Notes(t.Context()); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatal("memory store adopted a replacement directory", err)
			}
			if err := s.WriteNote(t.Context(), "identity.md", "Must never reach the replacement"); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatal("retained store authority reached a replacement directory", err)
			}
			if err := s.writeMarkdown(t.Context(), "identity.md", "Must never replace another directory's file"); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatal("snapshot write adopted replacement directory authority", err)
			}
			if err := s.backupJSON("isolated", []byte(`{"synthetic":true}`)); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatal("legacy backup adopted replacement directory authority", err)
			}
			if data, err := os.ReadFile(marker); err != nil || string(data) != "Synthetic replacement content" {
				t.Fatal("failed identity guard altered the replacement", err)
			}
		})
	}
}
