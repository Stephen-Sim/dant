package backups

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failingBackupProtection struct {
	protect   func(context.Context, []byte) ([]byte, error)
	unprotect func(context.Context, []byte) ([]byte, error)
}

func (protection failingBackupProtection) Protect(ctx context.Context, raw []byte) ([]byte, error) {
	if protection.protect != nil {
		return protection.protect(ctx, raw)
	}
	return fixtureProtection{}.Protect(ctx, raw)
}
func (protection failingBackupProtection) Unprotect(ctx context.Context, raw []byte) ([]byte, error) {
	if protection.unprotect != nil {
		return protection.unprotect(ctx, raw)
	}
	return fixtureProtection{}.Unprotect(ctx, raw)
}

type stalledBackupReader struct{}

func (stalledBackupReader) Read([]byte) (int, error) { return 0, nil }

type backupErrorReader struct{ err error }

func (reader backupErrorReader) Read([]byte) (int, error) { return 0, reader.err }

type shortBackupWriter struct{}

func (shortBackupWriter) Write(raw []byte) (int, error) { return len(raw) - 1, nil }

func assertVaultPrivateStagesEmpty(t *testing.T, vault *Vault) {
	t.Helper()
	entries, err := os.ReadDir(vault.staging)
	if err != nil || len(entries) != 0 {
		t.Fatal("private plaintext or failed transform staging survived")
	}
	entries, err = os.ReadDir(vault.directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".partial") {
			t.Fatal("failed immutable publication left a partial file")
		}
	}
}

func TestVaultSaveFailuresNeverPublishOrRetainPlaintext(t *testing.T) {
	for _, mode := range []string{"empty", "reader", "stalled", "cancelled", "protect", "wrapped-large", "transform", "stage-truncated", "stage-removed"} {
		t.Run(mode, func(t *testing.T) {
			vault, metadata := vaultFixture(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var reader io.Reader = bytes.NewReader(fixtureArchive([]byte("{}")))
			switch mode {
			case "empty":
				reader = strings.NewReader("")
			case "reader":
				reader = errorReader{}
			case "stalled":
				reader = stalledBackupReader{}
			case "cancelled":
				cancel()
			case "protect":
				vault.protection = failingBackupProtection{protect: func(context.Context, []byte) ([]byte, error) { return nil, errors.New("private key provider text") }}
			case "wrapped-large":
				vault.protection = failingBackupProtection{protect: func(context.Context, []byte) ([]byte, error) { return bytes.Repeat([]byte{'x'}, localHeaderLimit), nil }}
			case "transform", "stage-truncated", "stage-removed":
				vault.transform = func(ctx context.Context, request TransformRequest) error {
					if mode == "transform" {
						return context.Canceled
					}
					if mode == "stage-removed" {
						return os.Remove(request.File)
					}
					return os.Truncate(request.File, 1)
				}
			}
			err := vault.Save(ctx, reader, metadata)
			if err == nil || strings.Contains(err.Error(), "private") {
				t.Fatal("failed persistence published success or raw key-provider error")
			}
			if _, err := os.Stat(filepath.Join(vault.directory, metadata.ID+".dantbak")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("failed save published destination")
			}
			assertVaultPrivateStagesEmpty(t, vault)
		})
	}
}

func TestVaultRejectsMalformedEnvelopeBeforeReturningPlaintext(t *testing.T) {
	for _, mode := range []string{"magic", "zero-length", "large-length", "short-header", "duplicate", "types", "schema", "id", "wrapped", "iv", "tamper-aad", "tamper-tag", "hardlink"} {
		t.Run(mode, func(t *testing.T) {
			vault, metadata := vaultFixture(t)
			if err := vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
				t.Fatal(err)
			}
			name, _ := vault.file(metadata.ID)
			raw, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			prefix := len(localMagic) + 4
			length := int(binary.BigEndian.Uint32(raw[len(localMagic):prefix]))
			var header localHeader
			if json.Unmarshal(raw[prefix:prefix+length], &header) != nil {
				t.Fatal("invalid fixture envelope")
			}
			var replaced []byte
			switch mode {
			case "magic":
				raw[0] = '!'
			case "zero-length":
				binary.BigEndian.PutUint32(raw[len(localMagic):prefix], 0)
			case "large-length":
				binary.BigEndian.PutUint32(raw[len(localMagic):prefix], localHeaderLimit+1)
			case "short-header":
				raw = raw[:prefix+1]
			case "duplicate":
				replaced = []byte(`{"schema":1,"schema":1}`)
			case "types":
				replaced = []byte(`{"schema":"one"}`)
			case "schema":
				header.Schema = 2
			case "id":
				header.Metadata.ID = NewID()
			case "wrapped":
				header.WrappedKey = "!"
			case "iv":
				header.IV = base64.StdEncoding.EncodeToString([]byte("short"))
			case "tamper-aad":
				header.Metadata.CreatedAt++
			case "tamper-tag":
				raw[len(raw)-1] ^= 1
			case "hardlink":
				if err := os.Link(name, filepath.Join(t.TempDir(), "linked")); err != nil {
					t.Fatal(err)
				}
			}
			if replaced != nil || mode == "schema" || mode == "id" || mode == "wrapped" || mode == "iv" || mode == "tamper-aad" {
				if replaced == nil {
					replaced, _ = json.Marshal(header)
				}
				result := append([]byte{}, raw[:prefix]...)
				binary.BigEndian.PutUint32(result[len(localMagic):], uint32(len(replaced)))
				raw = append(append(result, replaced...), raw[prefix+length:]...)
			}
			if mode != "hardlink" {
				if err := os.WriteFile(name, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := vault.Open(t.Context(), metadata.ID); err == nil {
				t.Fatal("unvalidated envelope or unauthenticated bytes returned")
			}
			assertVaultPrivateStagesEmpty(t, vault)
		})
	}
}

func TestVaultOpenKeyAndSourceFailuresAreClassifiedWithoutTouchingOriginal(t *testing.T) {
	for _, mode := range []string{"missing-protection", "unprotect", "key-shape", "changed-source", "cancelled", "transform"} {
		t.Run(mode, func(t *testing.T) {
			vault, metadata := vaultFixture(t)
			if err := vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
				t.Fatal(err)
			}
			name, _ := vault.file(metadata.ID)
			original, _ := os.ReadFile(name)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch mode {
			case "missing-protection":
				vault.protection = nil
			case "unprotect":
				vault.protection = failingBackupProtection{unprotect: func(context.Context, []byte) ([]byte, error) { return nil, errors.New("private credential text") }}
			case "key-shape":
				vault.protection = failingBackupProtection{unprotect: func(context.Context, []byte) ([]byte, error) { return []byte("not a key"), nil }}
			case "changed-source":
				vault.protection = failingBackupProtection{unprotect: func(ctx context.Context, raw []byte) ([]byte, error) {
					if err := os.WriteFile(name, append(original, 0), 0600); err != nil {
						t.Fatal(err)
					}
					return fixtureProtection{}.Unprotect(ctx, raw)
				}}
			case "cancelled":
				cancel()
			case "transform":
				vault.transform = func(context.Context, TransformRequest) error { return context.Canceled }
			}
			if _, err := vault.Open(ctx, metadata.ID); err == nil || strings.Contains(err.Error(), "credential") {
				t.Fatal("unavailable key/source yielded plaintext or raw credentials")
			}
			current, _ := os.ReadFile(name)
			if mode != "changed-source" && !bytes.Equal(current, original) {
				t.Fatal("failed decrypt changed immutable encrypted backup")
			}
			assertVaultPrivateStagesEmpty(t, vault)
		})
	}
}

func TestVaultCatalogBoundsAndStorageOwnership(t *testing.T) {
	if _, err := NewVault(VaultOptions{DataDir: "relative"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("relative vault root accepted")
	}
	for _, child := range []string{"vm-backups", "backup-transforms"} {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, child), []byte("ordinary file"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := NewVault(VaultOptions{DataDir: root}); !errors.Is(err, ErrInvalid) {
			t.Fatal("non-directory private root accepted")
		}
	}
	vault, metadata := vaultFixture(t)
	for index := 0; index <= CatalogLimit; index++ {
		file, err := os.CreateTemp(vault.directory, "catalog-")
		if err != nil {
			t.Fatal(err)
		}
		file.Close()
	}
	if _, _, err := vault.List(); !errors.Is(err, ErrCatalogLimit) {
		t.Fatal("unbounded catalog enumeration accepted")
	}
	if err := vault.Retain(t.Context(), 0); !errors.Is(err, ErrInvalid) {
		t.Fatal("zero retention could remove all backups")
	}
	if err := vault.Retain(t.Context(), 1); !errors.Is(err, ErrCatalogLimit) {
		t.Fatal("retention proceeded with incomplete inventory")
	}
	if _, err := vault.ReadHeader("../" + metadata.ID); !errors.Is(err, ErrInvalid) {
		t.Fatal("caller-selected backup path escaped vault")
	}
}

func TestBackupBoundedCopyHandlesCancellationStallAndShortWrites(t *testing.T) {
	for _, test := range []struct {
		reader io.Reader
		writer io.Writer
		limit  int64
		want   error
	}{
		{stalledBackupReader{}, io.Discard, 10, io.ErrNoProgress},
		{strings.NewReader("bounded"), shortBackupWriter{}, 10, io.ErrShortWrite},
		{strings.NewReader("bounded"), io.Discard, 1, ErrSizeLimit},
		{backupErrorReader{io.ErrUnexpectedEOF}, io.Discard, 10, io.ErrUnexpectedEOF},
		{strings.NewReader("bounded"), &backupFailWriter{}, 10, io.ErrClosedPipe},
	} {
		if _, err := copyBounded(t.Context(), test.writer, test.reader, test.limit); !errors.Is(err, test.want) {
			t.Fatalf("bounded copy failure ignored: %v", err)
		}
	}
}
