package security

import (
	"bytes"
	"context"
	"crypto/cipher"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"testing/synctest"

	"github.com/google/uuid"
)

type unavailableEntropy struct{}

func (unavailableEntropy) Read([]byte) (int, error) {
	return 0, errors.New("synthetic entropy unavailable")
}

func TestSecurityIdentityFailuresNeverAdmitARequestOrPersistCredentials(t *testing.T) {
	if session, err := newSessionAuth("controller", 4317, 4318, unavailableEntropy{}); err == nil || session != nil || err.Error() != "session_unavailable" {
		t.Fatal("failed entropy produced a usable session", err)
	}
	if _, err := credentialAEAD([]byte{1}); err == nil {
		t.Fatal("invalid encryption key was accepted")
	}
	vault, err := NewVault(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	vault.newID = func() (uuid.UUID, error) { return uuid.Nil, errors.New("synthetic identity failure") }
	if _, err := vault.Upsert(t.Context(), CredentialInput{Name: stringPointer("Synthetic"), Secret: stringPointer("fixture-secret")}); !errors.Is(err, ErrVault) {
		t.Fatal("failed identity did not reject the credential", err)
	}
	if _, err := os.Lstat(vault.file); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("failed identity persisted an encrypted document", err)
	}
	changes := 0
	requests := NewCredentialRequests(vault, func() { changes++ })
	defer requests.Close()
	requests.newID = vault.newID
	if _, err := requests.Request(t.Context(), RequestInput{Name: "Synthetic"}, "owner", func() bool { return true }); !errors.Is(err, ErrCredentialInactive) {
		t.Fatal("failed identity admitted a pending credential request", err)
	}
	if snapshot := requests.Snapshot(t.Context()); len(snapshot.Requests) != 0 || changes != 0 {
		t.Fatal("failed admission changed the pending request list")
	}
}

func TestCredentialCommitFailuresPreserveTheExistingCiphertextWithoutRetry(t *testing.T) {
	for _, failure := range []string{"encryption-read", "encryption-write", "nonce", "persist"} {
		t.Run(failure, func(t *testing.T) {
			directory := t.TempDir()
			vault, err := NewVault(directory)
			if err != nil {
				t.Fatal(err)
			}
			metadata, err := vault.Upsert(t.Context(), CredentialInput{Name: stringPointer("Synthetic"), Secret: stringPointer("fixture-secret")})
			if err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(vault.file)
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			switch failure {
			case "encryption-read", "encryption-write":
				vault.newAEAD = func(key []byte) (cipher.AEAD, error) {
					calls++
					if failure == "encryption-read" || calls == 2 {
						return nil, errors.New("synthetic encryption failure")
					}
					return credentialAEAD(key)
				}
			case "nonce":
				vault.entropy = unavailableEntropy{}
			case "persist":
				vault.writeFile = func(context.Context, string, []byte, fs.FileMode) error {
					calls++
					return errors.New("synthetic persistence failure")
				}
			}
			if _, err := vault.Upsert(t.Context(), CredentialInput{ID: &metadata.ID, Secret: stringPointer("replacement-secret")}); !errors.Is(err, ErrVault) {
				t.Fatal("failed credential update was reported as committed", err)
			}
			after, err := os.ReadFile(vault.file)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatal("a failed update replaced the existing encrypted credential", err)
			}
			if (failure == "persist" || failure == "encryption-read") && calls != 1 || failure == "encryption-write" && calls != 2 {
				t.Fatal("an unconfirmed private operation was retried", calls)
			}
			if failure == "persist" {
				if _, err := vault.Remove(t.Context(), metadata.ID); !errors.Is(err, ErrVault) || calls != 2 {
					t.Fatal("failed removal lost its error or repeated its write", err, calls)
				}
			}
		})
	}
}

func TestCredentialStorageAndKeyCreationFailuresRemainPrivate(t *testing.T) {
	directory := t.TempDir()
	vault, _ := NewVault(directory)
	vault.entropy = unavailableEntropy{}
	if _, err := vault.Upsert(t.Context(), CredentialInput{Name: stringPointer("Synthetic"), Secret: stringPointer("fixture-secret")}); !errors.Is(err, ErrVault) {
		t.Fatal("failed key creation was accepted", err)
	}
	if _, err := os.Lstat(vault.keyFile); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("failed entropy left a key file", err)
	}
	blocked := filepath.Join(t.TempDir(), "ordinary-file")
	if err := os.WriteFile(blocked, []byte("synthetic marker"), 0o600); err != nil {
		t.Fatal(err)
	}
	broken, _ := NewVault(blocked)
	id := "00000000-0000-4000-8000-000000000001"
	for _, action := range []func() error{
		func() error { _, err := broken.List(t.Context()); return err },
		func() error { _, err := broken.Get(t.Context(), id); return err },
		func() error { _, err := broken.Remove(t.Context(), id); return err },
		func() error { _, err := broken.Find(t.Context(), "synthetic"); return err },
		func() error { _, err := broken.ContainsSecret(t.Context(), "fixture-secret"); return err },
		func() error { _, err := broken.Redact(t.Context(), "fixture-secret", false, nil); return err },
	} {
		if err := action(); !errors.Is(err, ErrVault) {
			t.Fatal("invalid private storage returned an unexpected public error", err)
		}
	}
	if raw, err := os.ReadFile(blocked); err != nil || string(raw) != "synthetic marker" {
		t.Fatal("failed private storage replaced an unrelated file", err)
	}
}

func TestPrivateOperationQueuesCancelBeforeReadingOrWriting(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		vault, _ := NewVault(t.TempDir())
		store, _ := NewVoiceKeyStore(t.TempDir(), "windows", "", fixtureProtector{})
		for _, operation := range []struct {
			gate chan struct{}
			run  func(context.Context) error
		}{
			{vault.gate, func(ctx context.Context) error { _, err := vault.List(ctx); return err }},
			{store.gate, func(ctx context.Context) error { _, err := store.Get(ctx); return err }},
			{store.gate, func(ctx context.Context) error { _, err := store.Set(ctx, "synthetic-api-key-1234"); return err }},
			{store.gate, func(ctx context.Context) error { _, err := store.Clear(ctx); return err }},
		} {
			operation.gate <- struct{}{}
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan error, 1)
			go func() { done <- operation.run(ctx) }()
			synctest.Wait()
			cancel()
			if err := <-done; !errors.Is(err, context.Canceled) {
				t.Fatal("a cancelled queue entry touched private storage", err)
			}
			<-operation.gate
		}
	})
}

func TestPrivateStorageRejectsLinkedSecretsAndKeepsOtherEntriesAfterRemoval(t *testing.T) {
	directory := t.TempDir()
	store, _ := NewVoiceKeyStore(directory, "windows", "", fixtureProtector{})
	if _, err := store.Set(t.Context(), "synthetic-api-key-1234"); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(store.file, filepath.Join(directory, "other-link")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(t.Context()); !errors.Is(err, ErrStoredVoiceKey) {
		t.Fatal("multiply linked protected secret was read", err)
	}
	if _, err := store.Clear(t.Context()); !errors.Is(err, ErrStoredVoiceKey) {
		t.Fatal("multiply linked protected secret was removed", err)
	}
	if _, err := os.Lstat(store.file); err != nil {
		t.Fatal("failed clear lost the protected original", err)
	}
	broken, _ := NewVoiceKeyStore(store.file, "windows", "", fixtureProtector{})
	if _, err := broken.Clear(t.Context()); !errors.Is(err, ErrStoredVoiceKey) {
		t.Fatal("non-directory private parent was accepted", err)
	}
	vault, _ := NewVault(t.TempDir())
	first, err := vault.Upsert(t.Context(), CredentialInput{Name: stringPointer("First"), Secret: stringPointer("a-longer-fixture-secret")})
	if err != nil {
		t.Fatal(err)
	}
	second, err := vault.Upsert(t.Context(), CredentialInput{Name: stringPointer("Second"), Secret: stringPointer("tiny")})
	if err != nil {
		t.Fatal(err)
	}
	if found, err := vault.ContainsSecret(t.Context(), "ordinary text"); err != nil || found {
		t.Fatal("ordinary content was classified as private", err)
	}
	if _, err := vault.Remove(t.Context(), first.ID); err != nil {
		t.Fatal(err)
	}
	if entries, err := vault.List(t.Context()); err != nil || len(entries) != 1 || entries[0].ID != second.ID {
		t.Fatal("removing one credential changed another identity", err)
	}
	if got := RedactCredentialText("tiny and a-longer-fixture-secret", []string{"tiny", "a-longer-fixture-secret"}, false); got != RedactedCredential+" and "+RedactedCredential {
		t.Fatal("overlapping secret ordering leaked content")
	}
	var input CredentialInput
	if err := json.Unmarshal([]byte(`{"name":false}`), &input); !errors.Is(err, ErrCredential) {
		t.Fatal("non-text credential input was accepted", err)
	}
}
