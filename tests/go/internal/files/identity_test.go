package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCapturedIdentityCannotFollowAReusedPathWithMatchingSizeAndTimestamp(t *testing.T) {
	for _, directory := range []bool{false, true} {
		parent := t.TempDir()
		name := filepath.Join(parent, "original")
		if directory {
			if err := os.Mkdir(name, 0o700); err != nil {
				t.Fatal(err)
			}
		} else if err := os.WriteFile(name, []byte("original"), 0o600); err != nil {
			t.Fatal(err)
		}
		captured, err := CaptureIdentity(name)
		if err != nil {
			t.Fatal(err)
		}
		retained := filepath.Join(parent, "retained")
		if err := os.Rename(name, retained); err != nil {
			t.Fatal(err)
		}
		if directory {
			if err := os.Mkdir(name, 0o700); err != nil {
				t.Fatal(err)
			}
		} else if err := os.WriteFile(name, []byte("replaced"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(name, captured.ModTime(), captured.ModTime()); err != nil {
			t.Fatal(err)
		}
		replacement, err := os.Lstat(name)
		if err != nil {
			t.Fatal(err)
		}
		if os.SameFile(captured, replacement) {
			t.Fatal("capture adopted the reused path's identity")
		}
		original, err := os.Lstat(retained)
		if err != nil || !os.SameFile(captured, original) {
			t.Fatal("capture lost the actual original identity", err)
		}
	}
	if _, err := CaptureIdentity("relative"); !errors.Is(err, ErrManagedPath) {
		t.Fatal("relative identity was accepted", err)
	}
	if _, err := CaptureIdentity(filepath.Join(t.TempDir(), "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("missing identity was invented", err)
	}
}
