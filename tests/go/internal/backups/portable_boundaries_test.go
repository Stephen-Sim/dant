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

func portableHeaderFixture(metadata Metadata) portableHeader {
	return portableHeader{
		Schema: 1, Cipher: "aes-256-gcm", Metadata: metadata, ArchiveBytes: 42,
		KDF: portableKDF{Name: "scrypt", N: scryptN, R: scryptR, P: scryptP, Salt: base64.StdEncoding.EncodeToString(make([]byte, portableSaltBytes))},
		IV:  base64.StdEncoding.EncodeToString(make([]byte, gcmNonceBytes)),
	}
}

func portableHeaderObject(t *testing.T, object map[string]json.RawMessage) []byte {
	t.Helper()
	raw, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	prefix := append([]byte(portableMagic), make([]byte, 4)...)
	binary.BigEndian.PutUint32(prefix[len(portableMagic):], uint32(len(raw)))
	return append(prefix, raw...)
}

func TestPortableHeaderRejectsUnknownSchemaUnboundedKDFAndNoncanonicalEncoding(t *testing.T) {
	_, metadata := vaultFixture(t)
	header := portableHeaderFixture(metadata)
	valid, err := portableHeaderBytes(header)
	if err != nil {
		t.Fatal(err)
	}
	if decoded, aad, err := readPortableHeader(bytes.NewReader(valid)); err != nil || decoded.Metadata != metadata || !bytes.Equal(aad, valid) {
		t.Fatal("valid portable header changed", err)
	}
	for _, mutate := range []func(map[string]json.RawMessage){
		func(value map[string]json.RawMessage) { value["schema"] = json.RawMessage(`2`) },
		func(value map[string]json.RawMessage) { value["schema"] = json.RawMessage(`"one"`) },
		func(value map[string]json.RawMessage) { value["extra"] = json.RawMessage(`true`) },
		func(value map[string]json.RawMessage) { value["kdf"] = json.RawMessage(`{}`) },
		func(value map[string]json.RawMessage) { value["metadata"] = json.RawMessage(`{}`) },
		func(value map[string]json.RawMessage) { value["archiveBytes"] = json.RawMessage(`0`) },
		func(value map[string]json.RawMessage) { value["archiveBytes"] = json.RawMessage(`1099511627776`) },
		func(value map[string]json.RawMessage) { value["iv"] = json.RawMessage(`"!!!!!!!!!!!!!!!!"`) },
		func(value map[string]json.RawMessage) { value["iv"] = json.RawMessage(`"bad"`) },
		func(value map[string]json.RawMessage) {
			value["kdf"] = json.RawMessage(`{"name":"scrypt","N":1,"r":8,"p":1,"salt":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`)
		},
		func(value map[string]json.RawMessage) {
			value["kdf"] = json.RawMessage(`{"name":"scrypt","N":65536,"r":8,"p":1,"salt":"bad"}`)
		},
	} {
		var object map[string]json.RawMessage
		if json.Unmarshal(valid[len(portableMagic)+4:], &object) != nil {
			t.Fatal("invalid fixture")
		}
		mutate(object)
		if _, _, err := readPortableHeader(bytes.NewReader(portableHeaderObject(t, object))); err == nil {
			t.Fatal("untrusted portable header was accepted")
		}
	}
	for _, length := range []uint32{0, portableHeaderLimit + 1} {
		prefix := append([]byte(portableMagic), make([]byte, 4)...)
		binary.BigEndian.PutUint32(prefix[len(portableMagic):], length)
		if _, _, err := readPortableHeader(bytes.NewReader(prefix)); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid portable header length was accepted", err)
		}
	}
	if _, _, err := readPortableHeader(bytes.NewReader(valid[:len(valid)-1])); !errors.Is(err, ErrInvalid) {
		t.Fatal("truncated portable header was accepted", err)
	}
	header.Metadata.AppVersion = strings.Repeat("x", portableHeaderLimit)
	if _, err := portableHeaderBytes(header); !errors.Is(err, ErrInvalid) {
		t.Fatal("unbounded portable header was generated", err)
	}
	if _, err := strictBase64("AB==", 1); !errors.Is(err, ErrInvalid) {
		t.Fatal("noncanonical base64 was accepted", err)
	}
}

func TestPortableExtractionCleanupRequiresExactOwnedDirectoryIdentity(t *testing.T) {
	parent := t.TempDir()
	directory, identity, err := extractionDirectory(parent)
	if err != nil {
		t.Fatal(err)
	}
	if err := cleanupExtraction(parent, filepath.Join(parent, "unrelated"), identity); !errors.Is(err, ErrInvalid) {
		t.Fatal("cleanup accepted an unrelated path", err)
	}
	retained := directory + "-retained"
	if err := os.Rename(directory, retained); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := cleanupExtraction(parent, directory, identity); !errors.Is(err, ErrSourceChanged) {
		t.Fatal("cleanup removed a replacement directory", err)
	}
	if _, err := os.Lstat(retained); err != nil {
		t.Fatal("cleanup lost the owned original", err)
	}
	if err := cleanupExtraction(parent, filepath.Join(parent, ".portable-extract-missing"), identity); err != nil {
		t.Fatal("absent owned extraction was not idempotent", err)
	}
	if _, _, err := extractionDirectory(filepath.Join(parent, "missing")); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid extraction parent was accepted", err)
	}
	file, err := os.CreateTemp(parent, "bounded-")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	writer := boundedFileWriter{file: file, count: ArchiveLimit}
	if n, err := writer.Write([]byte{1}); n != 0 || !errors.Is(err, ErrSizeLimit) {
		t.Fatal("portable writer exceeded the archive limit", err)
	}
	deriving <- struct{}{}
	_, err = portableKey(t.Context(), []byte("synthetic passphrase"), make([]byte, portableSaltBytes))
	<-deriving
	if !errors.Is(err, ErrBusy) {
		t.Fatal("concurrent password derivation was admitted", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := portableKey(ctx, []byte("synthetic passphrase"), make([]byte, portableSaltBytes)); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled password derivation continued", err)
	}
	for _, candidate := range []struct{ domain, path string }{{"data", "memory/note.md"}, {"data", "voice-key.other"}, {"workspace", "project/.npmrc"}} {
		want := candidate.path != "memory/note.md"
		if authenticationPath(candidate.domain, candidate.path) != want {
			t.Fatal("portable authentication filter drifted")
		}
	}
}

func TestPortableExportFailuresNeverPublishASuccessfulTransferOrRetainPlaintext(t *testing.T) {
	for _, mode := range []string{"invalid-archive", "metadata-mismatch", "encrypt-failure", "stage-truncated", "header-writer", "body-writer"} {
		t.Run(mode, func(t *testing.T) {
			vault, metadata := vaultFixture(t)
			input := fixtureArchive([]byte("{}"))
			if mode == "invalid-archive" {
				input = []byte("invalid archive")
			}
			if mode == "metadata-mismatch" {
				metadata.Bytes++
			}
			if err := vault.Save(t.Context(), bytes.NewReader(input), metadata); err != nil {
				t.Fatal(err)
			}
			calls := 0
			original := vault.transform
			vault.transform = func(ctx context.Context, request TransformRequest) error {
				calls++
				if calls == 2 && mode == "encrypt-failure" {
					return context.Canceled
				}
				if err := original(ctx, request); err != nil {
					return err
				}
				if calls == 2 && mode == "stage-truncated" {
					return os.Truncate(request.File, 1)
				}
				return nil
			}
			var output io.Writer = io.Discard
			if mode == "header-writer" {
				output = &archiveWriteFailure{failAt: 1}
			}
			if mode == "body-writer" {
				output = &archiveWriteFailure{failAt: 2}
			}
			if _, err := NewPortable(vault).Export(t.Context(), metadata.ID, "synthetic portable passphrase", output); err == nil {
				t.Fatal("failed portable transfer was reported successful")
			}
			assertVaultPrivateStagesEmpty(t, vault)
			if metadata, invalid, err := vault.List(); err != nil || invalid != 0 || len(metadata) != 1 {
				t.Fatal("failed portable export changed the encrypted source", err)
			}
		})
	}
	vault, _ := vaultFixture(t)
	if _, err := NewPortable(vault).Export(t.Context(), NewID(), "short", io.Discard); !errors.Is(err, ErrPassphrase) {
		t.Fatal("invalid export passphrase was accepted", err)
	}
	if _, err := NewPortable(vault).Export(t.Context(), NewID(), "synthetic portable passphrase", io.Discard); err == nil {
		t.Fatal("missing encrypted source was exported")
	}
	if _, err := NewPortable(vault).Import(t.Context(), strings.NewReader(""), "short"); !errors.Is(err, ErrPassphrase) {
		t.Fatal("invalid import passphrase was accepted", err)
	}
	if _, err := NewPortable(vault).Import(t.Context(), strings.NewReader(""), "synthetic portable passphrase"); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid import header was accepted", err)
	}
	_, metadata := vaultFixture(t)
	header, err := portableHeaderBytes(portableHeaderFixture(metadata))
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{0, 1, 100} {
		if _, err := NewPortable(vault).Import(t.Context(), bytes.NewReader(append(bytes.Clone(header), make([]byte, size)...)), "synthetic portable passphrase"); err == nil {
			t.Fatal("incomplete or oversized portable ciphertext was accepted")
		}
		assertVaultPrivateStagesEmpty(t, vault)
	}
}
