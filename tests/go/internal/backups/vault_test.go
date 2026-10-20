package backups

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fixtureProtection struct{}

func (fixtureProtection) Protect(_ context.Context, value []byte) ([]byte, error) {
	return append([]byte("fixture-wrapped:"), value...), nil
}

func (fixtureProtection) Unprotect(_ context.Context, value []byte) ([]byte, error) {
	if !bytes.HasPrefix(value, []byte("fixture-wrapped:")) {
		return nil, ErrInvalid
	}

	return append([]byte{}, value[len("fixture-wrapped:"):]...), nil
}

func fixtureTransform(ctx context.Context, request TransformRequest) error {
	raw, _ := json.Marshal(request)
	return RunTransform(ctx, bytes.NewReader(raw), &bytes.Buffer{})
}

func vaultFixture(t *testing.T) (*Vault, Metadata) {
	t.Helper()
	vault, err := NewVault(VaultOptions{DataDir: t.TempDir(), Protection: fixtureProtection{}, Transform: fixtureTransform})
	if err != nil {
		t.Fatal(err)
	}

	return vault, Metadata{ID: NewID(), CreatedAt: 1000, AppVersion: "0.4.7-beta.12", Bytes: 2, Files: 1, Source: "abcdef123456"}
}

func TestVaultPersistsOnlyAuthenticatedCiphertextAndCleansPrivatePlaintext(t *testing.T) {
	vault, metadata := vaultFixture(t)
	archive := fixtureArchive([]byte("{}"))
	if err := vault.Save(context.Background(), bytes.NewReader(archive), metadata); err != nil {
		t.Fatal(err)
	}
	file, _ := vault.file(metadata.ID)
	encrypted, err := os.ReadFile(file)
	if err != nil || !bytes.HasPrefix(encrypted, []byte(localMagic)) || bytes.Contains(encrypted, []byte(ArchiveMagic)) {
		t.Fatal("vault persisted plaintext or incompatible envelope")
	}
	listed, invalid, err := vault.List()
	if err != nil || invalid != 0 || len(listed) != 1 || listed[0] != metadata {
		t.Fatal("catalog metadata mismatch")
	}
	opened, err := vault.Open(context.Background(), metadata.ID)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := io.ReadAll(opened.Reader)
	if err != nil || !bytes.Equal(actual, archive) || opened.Metadata != metadata {
		t.Fatal("vault changed authenticated original bytes")
	}

	if err := opened.Reader.Close(); err != nil {
		t.Fatal(err)
	}

	if entries, err := os.ReadDir(vault.staging); err != nil || len(entries) != 0 {
		t.Fatal("private plaintext staging not removed")
	}

	if err := vault.Save(context.Background(), bytes.NewReader(archive), metadata); !errors.Is(err, ErrExists) {
		t.Fatal("existing immutable backup replaced")
	}
	encrypted[len(encrypted)-1] ^= 1
	if err := os.WriteFile(file, encrypted, 0600); err != nil {
		t.Fatal(err)
	}

	if _, err := vault.Open(context.Background(), metadata.ID); !errors.Is(err, ErrInvalid) {
		t.Fatal("unauthenticated plaintext returned")
	}

	if entries, err := os.ReadDir(vault.staging); err != nil || len(entries) != 0 {
		t.Fatal("failed authentication left plaintext staging")
	}
}

func TestVaultRetentionIsIndependentForEachSourceComputer(t *testing.T) {
	vault, _ := vaultFixture(t)
	for _, source := range []string{"111111111111", "222222222222"} {
		for _, at := range []int64{1000, 2000} {
			metadata := Metadata{ID: NewID(), CreatedAt: at, AppVersion: "0.4.7", Files: 1, Bytes: 2, Source: source}
			if err := vault.Save(context.Background(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
				t.Fatal(err)
			}
		}
	}

	if err := vault.Retain(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	metadata, invalid, err := vault.List()
	if err != nil || invalid != 0 || len(metadata) != 2 || metadata[0].Source == metadata[1].Source || metadata[0].CreatedAt != 2000 || metadata[1].CreatedAt != 2000 {
		t.Fatal("one computer evicted another computer's retained copy")
	}
}

func TestVaultRejectsInvalidMetadataAndIsolatesCatalogFailures(t *testing.T) {
	vault, metadata := vaultFixture(t)
	archive := fixtureArchive([]byte("{}"))
	bad := metadata
	bad.Source = "actual-account-id"
	if err := vault.Save(context.Background(), bytes.NewReader(archive), bad); !errors.Is(err, ErrInvalid) {
		t.Fatal("unvalidated metadata accepted")
	}

	if err := os.WriteFile(filepath.Join(vault.directory, NewID()+".dantbak"), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}

	if _, invalid, err := vault.List(); err != nil || invalid != 1 {
		t.Fatal("one invalid catalog entry hid all backups")
	}
	unprotected, err := NewVault(VaultOptions{DataDir: t.TempDir(), Transform: fixtureTransform})
	if err != nil {
		t.Fatal(err)
	}

	if err := unprotected.Save(context.Background(), strings.NewReader("fixture"), metadata); !errors.Is(err, ErrProtectionUnavailable) {
		t.Fatal("backup accepted without host encryption")
	}
}
