package backups

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkerBackupValidationDistinguishesFreshDataFromMissingState(t *testing.T) {
	for _, mode := range []string{"invalid-manifest", "missing-data", "missing-state", "state-directory", "fresh"} {
		t.Run(mode, func(t *testing.T) {
			archive, err := ValidateArchive(t.Context(), bytes.NewReader(fixtureArchive([]byte(restoreFixtureState))), t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			data := filepath.Join(archive.Directory, "data")
			state := filepath.Join(data, "state.json")
			switch mode {
			case "invalid-manifest":
				archive.Manifest.SchemaVersion++
			case "missing-data":
				if err := os.Rename(data, data+".retained"); err != nil {
					t.Fatal(err)
				}
			case "missing-state", "fresh", "state-directory":
				if err := os.Remove(state); err != nil {
					t.Fatal(err)
				}
				if mode == "state-directory" {
					if err := os.Mkdir(state, 0700); err != nil {
						t.Fatal(err)
					}
				}
				if mode == "fresh" {
					archive.Entries = []ArchiveEntry{{Domain: "data", Path: "empty", Directory: true}}
					archive.Manifest.Files = 0
					archive.Manifest.Bytes = 0
				}
			}
			err = ValidateWorkerBackup(t.Context(), archive)
			if mode == "fresh" {
				if err != nil {
					t.Fatal("empty fresh data requires no invented conversation", err)
				}
			} else if !errors.Is(err, ErrInvalid) {
				t.Fatal("unvalidated state was accepted", err)
			}
		})
	}
}

func TestWorkerBackupValidationKeepsValidDisabledIntegrationBytesUnchanged(t *testing.T) {
	archive, err := ValidateArchive(t.Context(), bytes.NewReader(fixtureArchive([]byte(cliFixtureState))), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(archive.Directory, "data", "telegram.json")
	original := []byte(`{"enabled":false,"forwardMode":"unread","combineReplies":true,"outbox":[],"receipts":[],"resultKeys":[]}`)
	if err := os.WriteFile(name, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateWorkerBackup(t.Context(), archive); err != nil {
		t.Fatal("read-only backup validation rejected a valid disabled integration", err)
	}
	if raw, err := os.ReadFile(name); err != nil || !bytes.Equal(raw, original) {
		t.Fatal("backup validation rewrote integration state", err)
	}
}
