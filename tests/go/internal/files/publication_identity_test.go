package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestManagedFilePublicationRetainsTheCallerOpenedIdentity(t *testing.T) {
	for _, mode := range []string{"success", "replaced", "modified", "hardlink", "missing-identity", "directory-identity"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			source := filepath.Join(root, "staging")
			destination := filepath.Join(root, "published")
			if err := os.WriteFile(source, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			identity, err := CaptureIdentity(source)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "replaced":
				if err := os.Rename(source, source+".retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(source, []byte("replaced"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chtimes(source, identity.ModTime(), identity.ModTime()); err != nil {
					t.Fatal(err)
				}
			case "modified":
				if err := os.WriteFile(source, []byte("changed-length"), 0600); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				if err := os.Link(source, filepath.Join(root, "alias")); err != nil {
					t.Fatal(err)
				}
			case "missing-identity":
				identity = nil
			case "directory-identity":
				identity, err = CaptureIdentity(root)
				if err != nil {
					t.Fatal(err)
				}
			}
			err = RenameManagedFile(t.Context(), source, destination, identity)
			if mode == "success" {
				if err != nil {
					t.Fatal(err)
				}
				if raw, err := os.ReadFile(destination); err != nil || string(raw) != "original" {
					t.Fatal("publication changed original bytes")
				}
			} else {
				want := ErrFileChanged
				if mode == "missing-identity" || mode == "directory-identity" {
					want = ErrManagedPath
				}
				if !errors.Is(err, want) {
					t.Fatal("publication adopted an unowned or changed file", err)
				}
				if _, err := os.Stat(destination); !os.IsNotExist(err) {
					t.Fatal("rejected publication created a destination")
				}
				if _, err := os.Stat(source); err != nil {
					t.Fatal("rejected publication removed its source")
				}
			}
		})
	}
}
