package backups

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"testing"

	"golang.org/x/crypto/scrypt"
)

func portableCredentialArchive(raw []byte) []byte {
	raw = bytes.ReplaceAll(raw, []byte(`"files":1`), []byte(`"files":2`))
	raw = bytes.ReplaceAll(raw, []byte(`"bytes":2`), []byte(`"bytes":5`))
	credential := []byte("key")
	sum := sha256.Sum256(credential)
	records := fmt.Sprintf("{\"type\":\"file\",\"domain\":\"data\",\"path\":\"credentials.json\",\"size\":3,\"executable\":false}\n{\"type\":\"chunk\",\"data\":\"%s\"}\n{\"type\":\"end\",\"sha256\":\"%s\"}\n", base64.StdEncoding.EncodeToString(credential), hex.EncodeToString(sum[:]))
	footer := bytes.Index(raw, []byte(`{"type":"footer"`))
	return append(append(append([]byte{}, raw[:footer]...), []byte(records)...), raw[footer:]...)
}

func TestPortableImportAuthenticatesBeforeRejectingInvalidContentsOrPublication(t *testing.T) {
	password := "isolated portable transfer passphrase"
	salt := make([]byte, portableSaltBytes)
	key, err := scrypt.Key([]byte(password), salt, scryptN, scryptR, scryptP, gcmKeyBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"invalid-archive", "metadata-mismatch", "authentication-content", "unprotected", "plaintext-truncated"} {
		t.Run(mode, func(t *testing.T) {
			vault, metadata := vaultFixture(t)
			raw := fixtureArchive([]byte("{}"))
			switch mode {
			case "invalid-archive":
				raw = []byte("authenticated but invalid archive")
			case "metadata-mismatch":
				metadata.Files++
			case "authentication-content":
				raw = portableCredentialArchive(raw)
				metadata.Files = 2
				metadata.Bytes = 5
			case "unprotected":
				vault.protection = nil
			case "plaintext-truncated":
				vault.transform = func(ctx context.Context, request TransformRequest) error {
					if err := fixtureTransform(ctx, request); err != nil {
						return err
					}
					return os.Truncate(request.File, 1)
				}
			}
			header := portableHeaderFixture(metadata)
			header.ArchiveBytes = int64(len(raw))
			aad, err := portableHeaderBytes(header)
			if err != nil {
				t.Fatal(err)
			}
			wire := append(bytes.Clone(aad), aead.Seal(nil, make([]byte, gcmNonceBytes), raw, aad)...)
			if _, err := NewPortable(vault).Import(t.Context(), bytes.NewReader(wire), password); err == nil {
				t.Fatal("authenticated invalid content or failed publication was accepted")
			}
			catalog, invalid, err := vault.List()
			if err != nil || invalid != 0 || len(catalog) != 0 {
				t.Fatal("failed import published an immutable backup")
			}
			assertVaultPrivateStagesEmpty(t, vault)
		})
	}
}

type shortPortableHeaderWriter struct {
	bytes.Buffer
	writes int
}

func (writer *shortPortableHeaderWriter) Write(raw []byte) (int, error) {
	writer.writes++
	if writer.writes == 1 {
		return writer.Buffer.Write(raw[:len(raw)-1])
	}
	return writer.Buffer.Write(raw)
}

func TestPortableExportDoesNotReportSuccessAfterShortHeaderWrite(t *testing.T) {
	vault, metadata := vaultFixture(t)
	if err := vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
		t.Fatal(err)
	}
	output := &shortPortableHeaderWriter{}
	if _, err := NewPortable(vault).Export(t.Context(), metadata.ID, "isolated portable transfer passphrase", output); err != io.ErrShortWrite {
		t.Fatal("incomplete portable header was reported as a successful backup")
	}
	if output.writes != 1 {
		t.Fatal("export continued after an incomplete header")
	}
	assertVaultPrivateStagesEmpty(t, vault)
}
