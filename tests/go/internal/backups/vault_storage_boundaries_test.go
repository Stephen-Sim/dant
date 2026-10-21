package backups

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type vaultFailureFile struct {
	*os.File
	failure string
	writes  int
	onStat  func()
	onClose func()
}

func (file *vaultFailureFile) Stat() (fs.FileInfo, error) {
	if file.onStat != nil {
		file.onStat()
	}
	return file.File.Stat()
}

func (file *vaultFailureFile) Write(data []byte) (int, error) {
	file.writes++
	if file.failure == "write" || (file.failure == "header" && file.writes == 2) || (file.failure == "body" && file.writes == 3) {
		return 0, io.ErrClosedPipe
	}
	if file.failure == "short-write" {
		return file.File.Write(data[:len(data)-1])
	}
	return file.File.Write(data)
}

func (file *vaultFailureFile) Truncate(size int64) error {
	if file.failure == "truncate" {
		return io.ErrClosedPipe
	}
	return file.File.Truncate(size)
}

func (file *vaultFailureFile) Sync() error {
	if file.failure == "sync" {
		return io.ErrClosedPipe
	}
	return file.File.Sync()
}

func (file *vaultFailureFile) Close() error {
	err := file.File.Close()
	if err == nil && file.onClose != nil {
		file.onClose()
	}
	if file.failure == "close" {
		return io.ErrClosedPipe
	}
	return err
}

func TestVaultPublicationCannotAdoptAReplacedClosedOutput(t *testing.T) {
	vault, metadata := vaultFixture(t)
	retained, replacement := "", ""
	vault.create = func(name string, flags int, permissions fs.FileMode) (vaultWriteFile, error) {
		file, err := os.OpenFile(name, flags, permissions)
		if err != nil {
			return nil, err
		}
		result := &vaultFailureFile{File: file}
		if strings.HasSuffix(name, ".partial") {
			result.onClose = func() {
				retained, replacement = name+".retained", name
				if err := os.Rename(name, retained); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(replacement, []byte("unowned replacement"), 0600); err != nil {
					t.Fatal(err)
				}
			}
		}
		return result, nil
	}
	if err := vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); !errors.Is(err, ErrInvalid) {
		t.Fatal("immutable publication adopted the current path instead of its opened output", err)
	}
	if raw, err := os.ReadFile(replacement); err != nil || string(raw) != "unowned replacement" {
		t.Fatal("publication cleanup removed an unowned replacement")
	}
	if raw, err := os.ReadFile(retained); err != nil || !bytes.HasPrefix(raw, []byte(localMagic)) {
		t.Fatal("failed publication lost its owned encrypted evidence")
	}
	if _, err := os.Stat(filepath.Join(vault.directory, metadata.ID+".dantbak")); !os.IsNotExist(err) {
		t.Fatal("replaced output became an immutable backup")
	}
	if entries, err := os.ReadDir(vault.staging); err != nil || len(entries) != 0 {
		t.Fatal("rejected encrypted publication retained plaintext staging")
	}
}

func TestVaultStorageFailureNeverPublishesAPartialBackup(t *testing.T) {
	for _, mode := range []string{
		"key-entropy", "nonce-entropy", "stage-create", "stage-write", "stage-short-write", "stage-truncate", "stage-sync", "stage-close",
		"output-create", "output-write", "output-header", "output-body", "output-short-write", "output-sync", "output-close",
	} {
		t.Run(mode, func(t *testing.T) {
			vault, metadata := vaultFixture(t)
			if mode == "key-entropy" {
				vault.entropy = bytes.NewReader(nil)
			} else if mode == "nonce-entropy" {
				vault.entropy = bytes.NewReader(make([]byte, gcmKeyBytes+gcmNonceBytes-1))
			}
			creates := 0
			vault.create = func(name string, flags int, permissions fs.FileMode) (vaultWriteFile, error) {
				creates++
				stage := creates == 1
				fail := strings.HasPrefix(mode, "stage-") && stage || strings.HasPrefix(mode, "output-") && !stage
				if fail && strings.HasSuffix(mode, "-create") {
					return nil, io.ErrClosedPipe
				}
				file, err := os.OpenFile(name, flags, permissions)
				if err != nil {
					return nil, err
				}
				result := &vaultFailureFile{File: file}
				if fail {
					_, result.failure, _ = strings.Cut(mode, "-")
				}
				return result, nil
			}
			if err := vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err == nil {
				t.Fatal("failed storage operation published a successful backup")
			}
			catalog, invalid, err := vault.List()
			if err != nil || invalid != 0 || len(catalog) != 0 {
				t.Fatal("failed storage operation left a published catalog entry")
			}
			assertVaultPrivateStagesEmpty(t, vault)
		})
	}
}

func TestVaultUncapturedStagingFailureCannotRemoveAReplacement(t *testing.T) {
	vault, metadata := vaultFixture(t)
	var original, replacement string
	vault.create = func(name string, flags int, permissions fs.FileMode) (vaultWriteFile, error) {
		file, err := os.OpenFile(name, flags, permissions)
		if err != nil {
			return nil, err
		}
		return &vaultFailureFile{File: file, onStat: func() {
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			original, replacement = name+".retained", name
			if err := os.Rename(name, original); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(replacement, []byte("unowned replacement"), 0600); err != nil {
				t.Fatal(err)
			}
		}}, nil
	}
	if err := vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); !errors.Is(err, ErrInvalid) {
		t.Fatal("failed identity capture was accepted", err)
	}
	if raw, err := os.ReadFile(replacement); err != nil || string(raw) != "unowned replacement" {
		t.Fatal("failed identity capture removed an unowned staging replacement")
	}
	if raw, err := os.ReadFile(original); err != nil || len(raw) != 0 {
		t.Fatal("uncaptured original was deleted or received plaintext")
	}
	if entries, err := os.ReadDir(vault.directory); err != nil || len(entries) != 0 {
		t.Fatal("failed identity capture published encrypted output")
	}
}

func TestVaultOwnedStagingAndLocalPublicationFailuresKeepOtherData(t *testing.T) {
	for _, mode := range []string{"vault-missing", "staging-missing", "cleanup-directory", "local-rename", "retention-cancelled", "default-transform"} {
		t.Run(mode, func(t *testing.T) {
			vault, metadata := vaultFixture(t)
			switch mode {
			case "vault-missing":
				if err := os.Rename(vault.directory, vault.directory+".retained"); err != nil {
					t.Fatal(err)
				}
				if _, err := vault.file(metadata.ID); !errors.Is(err, ErrInvalid) {
					t.Fatal("missing vault root was accepted")
				}
				if err := vault.Save(t.Context(), bytes.NewReader(nil), metadata); err == nil {
					t.Fatal("missing vault destination was accepted")
				}
			case "staging-missing":
				if err := os.Rename(vault.staging, vault.staging+".retained"); err != nil {
					t.Fatal(err)
				}
				if _, _, err := vault.stage(t.Context(), bytes.NewReader([]byte("archive")), false); !errors.Is(err, ErrInvalid) {
					t.Fatal("missing staging root was accepted")
				}
			case "cleanup-directory":
				stage := privateStage{file: t.TempDir()}
				if !errors.Is(cleanStage(stage), ErrSourceChanged) {
					t.Fatal("staging cleanup accepted an unowned directory")
				}
			case "local-rename":
				vault.create = func(name string, flags int, permissions fs.FileMode) (vaultWriteFile, error) {
					if strings.HasSuffix(name, ".partial") {
						if err := os.Mkdir(filepath.Join(vault.directory, metadata.ID+".dantbak"), 0700); err != nil {
							t.Fatal(err)
						}
					}
					return os.OpenFile(name, flags, permissions)
				}
				if err := vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); !errors.Is(err, ErrInvalid) {
					t.Fatal("publication overwrote an occupied immutable destination", err)
				}
				info, err := os.Stat(filepath.Join(vault.directory, metadata.ID+".dantbak"))
				if err != nil || !info.IsDir() {
					t.Fatal("failed publication removed an unowned destination")
				}
				assertVaultPrivateStagesEmpty(t, vault)
			case "retention-cancelled":
				for _, createdAt := range []int64{1000, 2000} {
					metadata.ID, metadata.CreatedAt = NewID(), createdAt
					if err := vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
						t.Fatal(err)
					}
				}
				ctx, cancel := context.WithCancel(t.Context())
				cancel()
				if !errors.Is(vault.Retain(ctx, 1), context.Canceled) {
					t.Fatal("cancelled retention removed backups")
				}
				if catalog, _, err := vault.List(); err != nil || len(catalog) != 2 {
					t.Fatal("cancelled retention changed immutable backups")
				}
			case "default-transform":
				selected, err := NewVault(VaultOptions{DataDir: t.TempDir(), Protection: fixtureProtection{}})
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(t.Context())
				cancel()
				if err := selected.transform(ctx, TransformRequest{}); err == nil {
					t.Fatal("cancelled default transform launched successfully")
				}
			}
		})
	}
}
