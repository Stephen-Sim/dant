package backups

import (
	"bytes"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestPortableExportStorageFailuresKeepEncryptedOriginalAndUnownedReplacements(t *testing.T) {
	for _, mode := range []string{"create", "write", "truncate", "sync", "close", "identity-lost"} {
		t.Run(mode, func(t *testing.T) {
			vault, metadata := vaultFixture(t)
			if err := vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
				t.Fatal(err)
			}
			originalName := filepath.Join(vault.directory, metadata.ID+".dantbak")
			original, err := os.ReadFile(originalName)
			if err != nil {
				t.Fatal(err)
			}
			creates := 0
			retained, replacement := "", ""
			vault.create = func(name string, flags int, permissions fs.FileMode) (vaultWriteFile, error) {
				creates++
				if creates == 2 && mode == "create" {
					return nil, io.ErrClosedPipe
				}
				file, err := os.OpenFile(name, flags, permissions)
				if err != nil {
					return nil, err
				}
				result := &vaultFailureFile{File: file}
				if creates == 2 {
					result.failure = mode
					if mode == "identity-lost" {
						result.onStat = func() {
							if err := file.Close(); err != nil {
								t.Fatal(err)
							}
							retained, replacement = name+".retained", name
							if err := os.Rename(name, retained); err != nil {
								t.Fatal(err)
							}
							if err := os.WriteFile(replacement, []byte("unowned replacement"), 0600); err != nil {
								t.Fatal(err)
							}
						}
					}
				}
				return result, nil
			}
			var output bytes.Buffer
			if _, err := NewPortable(vault).Export(t.Context(), metadata.ID, "isolated portable transfer passphrase", &output); err == nil || output.Len() != 0 {
				t.Fatal("failed portable preparation emitted or reported a transfer")
			}
			actual, err := os.ReadFile(originalName)
			if err != nil || !bytes.Equal(actual, original) {
				t.Fatal("portable failure changed its encrypted source")
			}
			if mode == "identity-lost" {
				if raw, err := os.ReadFile(replacement); err != nil || string(raw) != "unowned replacement" {
					t.Fatal("portable cleanup adopted an unowned path")
				}
				if raw, err := os.ReadFile(retained); err != nil || len(raw) != 0 {
					t.Fatal("uncaptured empty stage was removed or received plaintext")
				}
				if entries, err := os.ReadDir(vault.staging); err != nil || len(entries) != 2 {
					t.Fatal("portable failure retained extra plaintext staging")
				}
			} else {
				assertVaultPrivateStagesEmpty(t, vault)
			}
		})
	}
}
