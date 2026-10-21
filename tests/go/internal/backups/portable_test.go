package backups

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
)

func TestPortableRoundTripRetainsFormatAndFiltersAuthentication(t *testing.T) {
	source, metadata := vaultFixture(t)
	raw := fixtureArchive([]byte("{}"))
	raw = bytes.ReplaceAll(raw, []byte(`"files":1`), []byte(`"files":2`))
	raw = bytes.ReplaceAll(raw, []byte(`"bytes":2`), []byte(`"bytes":5`))
	credential := []byte("key")
	sum := sha256.Sum256(credential)
	records := fmt.Sprintf("{\"type\":\"file\",\"domain\":\"data\",\"path\":\"credentials.json\",\"size\":3,\"executable\":false}\n{\"type\":\"chunk\",\"data\":\"%s\"}\n{\"type\":\"end\",\"sha256\":\"%s\"}\n", base64.StdEncoding.EncodeToString(credential), hex.EncodeToString(sum[:]))
	footer := bytes.Index(raw, []byte(`{"type":"footer"`))
	raw = append(append(append([]byte{}, raw[:footer]...), []byte(records)...), raw[footer:]...)
	metadata.Files = 2
	metadata.Bytes = 5
	if err := source.Save(context.Background(), bytes.NewReader(raw), metadata); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	exported, err := NewPortable(source).Export(context.Background(), metadata.ID, "fixture portable passphrase", &output)
	if err != nil {
		t.Fatal(err)
	}

	if exported.ID != metadata.ID || exported.Files != 1 || exported.Bytes != 2 || !bytes.HasPrefix(output.Bytes(), []byte(portableMagic)) || bytes.Contains(output.Bytes(), []byte(ArchiveMagic)) {
		t.Fatal("portable format or filtered metadata mismatch")
	}
	destination, _ := vaultFixture(t)
	imported, err := NewPortable(destination).Import(context.Background(), bytes.NewReader(output.Bytes()), "fixture portable passphrase")
	if err != nil || imported != exported {
		t.Fatalf("portable import failed: %v", err)
	}
	opened, err := destination.Open(context.Background(), imported.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Reader.Close()
	plaintext, err := io.ReadAll(opened.Reader)
	if err != nil || bytes.Contains(plaintext, []byte("credentials.json")) {
		t.Fatal("portable exported authentication records")
	}

	if _, err := NewPortable(destination).Import(context.Background(), bytes.NewReader(output.Bytes()), "fixture portable passphrase"); !errors.Is(err, ErrExists) {
		t.Fatal("portable import replaced an immutable existing backup")
	}
	wrong, _ := vaultFixture(t)
	if _, err := NewPortable(wrong).Import(context.Background(), bytes.NewReader(output.Bytes()), "different fixture passphrase"); !errors.Is(err, ErrInvalid) {
		t.Fatal("wrong passphrase accepted")
	}

	if names, err := os.ReadDir(wrong.staging); err != nil || len(names) != 0 {
		t.Fatal("failed portable import left private staging")
	}
}

func TestPortableAuthenticationPathsAndPassphraseBounds(t *testing.T) {
	for _, fixture := range []struct {
		domain, path string
		excluded     bool
	}{{"data", "state.json", false}, {"data", "credentials/nested.json", true}, {"data", "voice-key.dpapi", true}, {"workspace", "project/.git/config", true}, {"workspace", "project/.env", true}, {"workspace", "project/.env.example", false}, {"workspace", "project/.ssh/id_ed25519", true}, {"workspace", "project/readme.txt", false}} {
		if authenticationPath(fixture.domain, fixture.path) != fixture.excluded {
			t.Fatal("authentication path filter mismatch")
		}
	}
	for _, value := range []string{"short", strings.Repeat("x", PortablePassphraseMaxBytes+1)} {
		if _, err := portablePassword(value); !errors.Is(err, ErrPassphrase) {
			t.Fatal("invalid passphrase accepted")
		}
	}

	if _, _, err := readPortableHeader(strings.NewReader("not an archive")); !errors.Is(err, ErrInvalid) {
		t.Fatal("malformed portable header accepted")
	}
}
