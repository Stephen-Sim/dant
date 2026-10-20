package backups

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMappedGCMUsesCompatibleExactOverlapWithoutChangingOriginalArchive(t *testing.T) {
	key := bytes.Repeat([]byte{0x51}, 32)
	nonce := bytes.Repeat([]byte{0x19}, 12)
	aad := []byte("original portable header bytes")
	plaintext := bytes.Repeat([]byte("fixture binary bytes\x00\xff"), 50000)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	expected := gcm.Seal(nil, nonce, plaintext, aad)
	directory := t.TempDir()
	name, err := stageName(directory, "12345678-1234-1234-1234-123456789abc")
	if err != nil {
		t.Fatal(err)
	}
	request := TransformRequest{Directory: directory, File: name, Mode: "encrypt", Bytes: int64(len(plaintext)), Key: key, Nonce: nonce, AAD: aad}
	if err := os.WriteFile(name, append(append([]byte{}, plaintext...), make([]byte, 16)...), 0600); err != nil {
		t.Fatal(err)
	}
	invoke := func(request TransformRequest) error {
		raw, _ := json.Marshal(request)
		var result bytes.Buffer
		err := RunTransform(context.Background(), bytes.NewReader(raw), &result)
		if err == nil {
			var receipt TransformReceipt
			if json.Unmarshal(result.Bytes(), &receipt) != nil || !receipt.OK {
				t.Fatal("missing fixed success receipt")
			}
		}
		return err
	}

	if err := invoke(request); err != nil {
		t.Fatal(err)
	}
	encrypted, err := os.ReadFile(name)
	if err != nil || !bytes.Equal(encrypted, expected) {
		t.Fatal("mapped exact-overlap cipher does not match standard GCM format")
	}
	original := filepath.Join(directory, "original-archive.dantbackup")
	if err := os.WriteFile(original, encrypted, 0600); err != nil {
		t.Fatal(err)
	}
	request.Mode = "decrypt"
	if err := invoke(request); err != nil {
		t.Fatal(err)
	}
	decrypted, err := os.ReadFile(name)
	if err != nil || !bytes.Equal(decrypted, plaintext) {
		t.Fatal("authenticated plaintext mismatch")
	}
	untouched, _ := os.ReadFile(original)
	if !bytes.Equal(untouched, expected) {
		t.Fatal("original archive was modified")
	}

	if err := os.WriteFile(name, encrypted, 0600); err != nil {
		t.Fatal(err)
	}
	request.AAD = []byte("tampered header")
	if err := invoke(request); !errors.Is(err, ErrInvalid) {
		t.Fatal("tampered authenticated header accepted")
	}
	wiped, _ := os.ReadFile(name)
	if !bytes.Equal(wiped, make([]byte, len(wiped))) {
		t.Fatal("failed authentication left staged plaintext")
	}
}

func TestTransformRejectsWrongIdentitySizesAndHardlinks(t *testing.T) {
	directory := t.TempDir()
	name, _ := stageName(directory, "12345678-1234-1234-1234-123456789abc")
	if err := os.WriteFile(name, make([]byte, 32), 0600); err != nil {
		t.Fatal(err)
	}
	request := TransformRequest{Directory: directory, File: name, Mode: "decrypt", Bytes: 16, Key: make([]byte, 32), Nonce: make([]byte, 12)}
	for _, patch := range []func(*TransformRequest){func(value *TransformRequest) { value.File = filepath.Join(directory, "user-file") }, func(value *TransformRequest) { value.Bytes = 17 }, func(value *TransformRequest) { value.Key = nil }, func(value *TransformRequest) { value.Bytes = ArchiveLimit + 1 }} {
		copy := request
		patch(&copy)
		raw, _ := json.Marshal(copy)
		if err := RunTransform(context.Background(), bytes.NewReader(raw), &bytes.Buffer{}); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid transform boundary accepted")
		}
	}

	if err := os.Link(name, filepath.Join(directory, "linked-copy")); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(request)
	if err := RunTransform(context.Background(), bytes.NewReader(raw), &bytes.Buffer{}); !errors.Is(err, ErrInvalid) {
		t.Fatal("multiply linked stage accepted")
	}
}
