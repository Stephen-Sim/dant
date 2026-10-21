package security

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func encryptedCredentialFixture(t *testing.T, directory string, plain []byte) string {
	t.Helper()
	private := filepath.Join(directory, "credentials")
	if err := os.MkdirAll(private, 0o700); err != nil {
		t.Fatal(err)
	}
	key := bytes.Repeat([]byte{0x4b}, VaultKeyBytes)
	if err := os.WriteFile(filepath.Join(private, "master.key"), key, 0o600); err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := bytes.Repeat([]byte{0x31}, aead.NonceSize())
	sealed := aead.Seal(nil, nonce, plain, []byte("dant.credentials.v1"))
	boundary := len(sealed) - aead.Overhead()
	envelope := map[string]any{
		"version": 1,
		"iv":      base64.StdEncoding.EncodeToString(nonce),
		"tag":     base64.StdEncoding.EncodeToString(sealed[boundary:]),
		"data":    base64.StdEncoding.EncodeToString(sealed[:boundary]),
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(private, "vault.enc")
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestVaultRejectsAuthenticatedButMalformedEntriesWithoutReplacingTheCiphertext(t *testing.T) {
	valid := `{"id":"00000000-0000-4000-8000-000000000001","name":"Synthetic","service":"fixture.invalid","username":"user","secret":"private-fixture-secret","createdAt":0,"updatedAt":1}`
	fixtures := []string{
		`null`, `{}`, `[false]`, `[{}]`, `[` + strings.Replace(valid, `"name":"Synthetic"`, `"name":"\ud800"`, 1) + `]`,
		`[` + strings.Replace(valid, `"createdAt":0`, `"createdAt":null`, 1) + `]`,
		`[` + strings.Replace(valid, `"updatedAt":1`, `"updatedAt":"bad"`, 1) + `]`,
		`[` + strings.Replace(valid, `"00000000-0000-4000-8000-000000000001"`, `"not-an-id"`, 1) + `]`,
		`[` + strings.Replace(valid, `"name":"Synthetic"`, `"name":false`, 1) + `]`,
		`[` + strings.Replace(valid, `"updatedAt":1`, `"updatedAt":1,"updatedAt":2`, 1) + `]`,
		`[` + strings.Repeat(valid+",", VaultEntryLimit) + valid + `]`,
	}
	for index, plain := range fixtures {
		t.Run(string(rune('a'+index)), func(t *testing.T) {
			directory := t.TempDir()
			file := encryptedCredentialFixture(t, directory, []byte(plain))
			before, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			vault, err := NewVault(directory)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := vault.List(t.Context()); !errors.Is(err, ErrVault) {
				t.Fatal("malformed authenticated storage became a valid credential list", err)
			}
			after, err := os.ReadFile(file)
			if err != nil || !bytes.Equal(after, before) {
				t.Fatal("a failed read replaced the original encrypted data", err)
			}
		})
	}
}

func TestVaultRejectsMalformedEnvelopeAndMissingOrInvalidMasterKey(t *testing.T) {
	for _, raw := range []string{
		`[]`, `{"version":2}`, `{"version":"1"}`, `{"version":1,"iv":"!","tag":"!","data":"!"}`,
		`{"version":1,"iv":"","tag":"","data":""}`, `{"version":1,"version":1}`, `{"version":`,
	} {
		directory := t.TempDir()
		file := encryptedCredentialFixture(t, directory, []byte(`[]`))
		if err := os.WriteFile(file, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		vault, _ := NewVault(directory)
		if _, err := vault.Get(t.Context(), "00000000-0000-4000-8000-000000000001"); !errors.Is(err, ErrVault) {
			t.Fatal("malformed encrypted envelope was consumed", err)
		}
	}
	for _, key := range [][]byte{nil, {1}, bytes.Repeat([]byte{2}, VaultKeyBytes+1)} {
		directory := t.TempDir()
		file := encryptedCredentialFixture(t, directory, []byte(`[]`))
		keyFile := filepath.Join(filepath.Dir(file), "master.key")
		if err := os.WriteFile(keyFile, key, 0o600); err != nil {
			t.Fatal(err)
		}
		vault, _ := NewVault(directory)
		if _, err := vault.List(t.Context()); !errors.Is(err, ErrVault) {
			t.Fatal("invalid master key became a new vault", err)
		}
	}
	directory := t.TempDir()
	file := encryptedCredentialFixture(t, directory, []byte(`[]`))
	if err := os.Remove(filepath.Join(filepath.Dir(file), "master.key")); err != nil {
		t.Fatal(err)
	}
	vault, _ := NewVault(directory)
	if _, err := vault.Upsert(t.Context(), CredentialInput{Name: stringPointer("Synthetic"), Secret: stringPointer("fixture")}); !errors.Is(err, ErrVault) {
		t.Fatal("missing master key was silently regenerated over an existing vault", err)
	}
}

func TestVaultValidationCapacityAndFailurePathsPreserveTheirPublicErrors(t *testing.T) {
	if _, err := NewVault("relative"); err == nil {
		t.Fatal("relative private directory was accepted")
	}
	vault, _ := NewVault(t.TempDir())
	for _, input := range []CredentialInput{
		{ID: stringPointer("bad")},
		{ID: stringPointer("00000000-0000-4000-8000-000000000001")},
		{Name: stringPointer(""), Secret: stringPointer("fixture")},
		{Name: stringPointer("Synthetic"), Secret: stringPointer(strings.Repeat("x", credentialSecretUnits+1))},
		{Name: stringPointer("Synthetic"), Username: stringPointer("bad\x00name"), Secret: stringPointer("fixture")},
	} {
		if _, err := vault.Upsert(t.Context(), input); !errors.Is(err, ErrCredential) && !errors.Is(err, ErrCredentialMissing) {
			t.Fatal("invalid credential input was accepted", err)
		}
	}
	if _, err := vault.Get(t.Context(), "bad"); !errors.Is(err, ErrCredential) {
		t.Fatal(err)
	}
	if _, err := vault.Get(t.Context(), "00000000-0000-4000-8000-000000000001"); !errors.Is(err, ErrCredentialMissing) {
		t.Fatal(err)
	}
	if _, err := vault.Remove(t.Context(), "bad"); !errors.Is(err, ErrCredential) {
		t.Fatal(err)
	}
	if _, err := vault.Find(t.Context(), strings.Repeat("x", credentialQueryUnits+1)); !errors.Is(err, ErrCredential) {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	for _, action := range []func() error{
		func() error { _, err := vault.List(cancelled); return err },
		func() error { _, err := vault.Get(cancelled, "00000000-0000-4000-8000-000000000001"); return err },
		func() error { _, err := vault.Upsert(cancelled, CredentialInput{}); return err },
		func() error { _, err := vault.Remove(cancelled, "00000000-0000-4000-8000-000000000001"); return err },
		func() error { _, err := vault.ContainsSecret(cancelled, "synthetic"); return err },
		func() error { _, err := vault.Redact(cancelled, "synthetic", false, nil); return err },
	} {
		if err := action(); !errors.Is(err, context.Canceled) {
			t.Fatal("private operation ignored cancellation", err)
		}
	}
	entries := make([]Credential, VaultEntryLimit)
	for index := range entries {
		entries[index] = Credential{CredentialMetadata: CredentialMetadata{ID: fmt.Sprintf("00000000-0000-4000-8000-%012d", index+1), Name: "Searchable", Service: "synthetic-service"}, Secret: "repeated-fixture-secret"}
	}
	if err := vault.write(t.Context(), entries); err != nil {
		t.Fatal(err)
	}
	if found, err := vault.Find(t.Context(), "Searchable"); err != nil || len(found) != credentialSearchLimit {
		t.Fatal("credential search did not preserve its result limit", err)
	}
	if _, err := vault.Upsert(t.Context(), CredentialInput{Name: stringPointer("Overflow"), Secret: stringPointer("fixture")}); !errors.Is(err, ErrVaultFull) {
		t.Fatal("credential capacity became unbounded", err)
	}
	if err := vault.write(t.Context(), append(entries, Credential{})); !errors.Is(err, ErrVaultFull) {
		t.Fatal("serialized vault capacity became unbounded", err)
	}
	entries[0].CreatedAt = math.NaN()
	if err := vault.write(t.Context(), entries); !errors.Is(err, ErrVault) {
		t.Fatal("non-finite private metadata was persisted", err)
	}
	if got := RedactCredentialText("xxababcab", []string{"ababcabc"}, true); got != "xx"+RedactedCredential {
		t.Fatal("overlapping private prefix escaped streaming redaction")
	}
	if got := RedactCredentialText("ababcabcababcab", []string{"ababcabc"}, true); got != RedactedCredential+RedactedCredential {
		t.Fatal("repeated prefix did not retain exact redaction boundaries")
	}
}

type failingKeyProtector struct {
	protect   func(context.Context, []byte) ([]byte, error)
	unprotect func(context.Context, []byte) ([]byte, error)
}

func (fixture failingKeyProtector) Protect(ctx context.Context, value []byte) ([]byte, error) {
	if fixture.protect != nil {
		return fixture.protect(ctx, value)
	}
	return (fixtureProtector{}).Protect(ctx, value)
}

func (fixture failingKeyProtector) Unprotect(ctx context.Context, value []byte) ([]byte, error) {
	if fixture.unprotect != nil {
		return fixture.unprotect(ctx, value)
	}
	return (fixtureProtector{}).Unprotect(ctx, value)
}

func TestVoiceKeyFailuresDoNotExposeOrReplaceAnUnconfirmedProtectedKey(t *testing.T) {
	if _, err := NewVoiceKeyStore("relative", "windows", "", nil); err == nil {
		t.Fatal("relative secret path was accepted")
	}
	if _, err := ValidateAPIKey("synthetic key with spaces"); !errors.Is(err, ErrAPIKey) {
		t.Fatal("non-token secret spelling was accepted", err)
	}
	for _, fixture := range []struct {
		platform string
		protect  Protector
	}{
		{"linux", fixtureProtector{}}, {"windows", nil},
		{"windows", failingKeyProtector{protect: func(context.Context, []byte) ([]byte, error) { return nil, errors.New("synthetic protection failure") }}},
		{"windows", failingKeyProtector{protect: func(context.Context, []byte) ([]byte, error) { return []byte{}, nil }}},
		{"windows", failingKeyProtector{protect: func(context.Context, []byte) ([]byte, error) { return make([]byte, MaxProtectedBlobBytes+1), nil }}},
	} {
		store, _ := NewVoiceKeyStore(t.TempDir(), fixture.platform, "", fixture.protect)
		if _, err := store.Set(t.Context(), "synthetic-secret-token"); !errors.Is(err, ErrSecretProtection) {
			t.Fatal("an unprotected or oversized key was accepted", err)
		}
	}
	store, _ := NewVoiceKeyStore(t.TempDir(), "linux", "", nil)
	if value, err := store.Get(t.Context()); err != nil || value != "" {
		t.Fatal("missing optional environment key became configured", err)
	}
	if _, err := store.Set(t.Context(), "tiny"); !errors.Is(err, ErrAPIKey) {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		name string
		blob []byte
		key  Protector
	}{
		{"unavailable protector", []byte("synthetic blob"), nil},
		{"decrypt failure", []byte("synthetic blob"), failingKeyProtector{unprotect: func(context.Context, []byte) ([]byte, error) { return nil, errors.New("synthetic private cause") }}},
		{"invalid decoded key", []byte("synthetic blob"), failingKeyProtector{unprotect: func(context.Context, []byte) ([]byte, error) { return []byte("bad"), nil }}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			store, _ := NewVoiceKeyStore(t.TempDir(), "win32", "synthetic-environment-token", fixture.key)
			if err := os.WriteFile(store.file, fixture.blob, 0o600); err != nil {
				t.Fatal(err)
			}
			if value, err := store.Get(t.Context()); value != "" || (!errors.Is(err, ErrStoredVoiceKey) && !errors.Is(err, ErrSecretProtection)) {
				t.Fatal("unconfirmed protected storage fell back to another credential", err)
			}
			after, err := os.ReadFile(store.file)
			if err != nil || !bytes.Equal(after, fixture.blob) {
				t.Fatal("failed protection replaced existing bytes", err)
			}
		})
	}
	store, _ = NewVoiceKeyStore(t.TempDir(), "windows", "", fixtureProtector{})
	if err := os.Mkdir(store.file, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Status(); !errors.Is(err, ErrStoredVoiceKey) {
		t.Fatal("non-file protected storage became configured", err)
	}
	if _, err := store.Get(t.Context()); !errors.Is(err, ErrStoredVoiceKey) {
		t.Fatal(err)
	}
	if _, err := store.Set(t.Context(), "synthetic-secret-token"); !errors.Is(err, ErrStoredVoiceKey) {
		t.Fatal(err)
	}
	if _, err := store.Clear(t.Context()); !errors.Is(err, ErrStoredVoiceKey) {
		t.Fatal(err)
	}
	missing, _ := NewVoiceKeyStore(t.TempDir(), "windows", "", fixtureProtector{})
	if status, err := missing.Clear(t.Context()); err != nil || status.Configured {
		t.Fatal("clearing an absent key became a storage error", err)
	}
}
