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
	"path/filepath"
	"strings"
	"testing"
)

func TestPortableAgentDataScopeAndBinarySkillsSurviveAuthenticationFiltering(t *testing.T) {
	options := workerSnapshotFixture(t)
	skill := filepath.Join(skillFixtureRoot(t, options.WorkspaceRoot), "asset.png")
	content := []byte{0x89, 'P', 'N', 'G', 0, 255, '\n'}
	if err := os.WriteFile(skill, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(options.DataDir, "voice-key.dpapi"), []byte("isolated protected credential"), 0600); err != nil {
		t.Fatal(err)
	}
	backup, err := CreateWorkerBackup(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	var archive bytes.Buffer
	if err := backup.WriteTo(t.Context(), &archive); err != nil {
		t.Fatal(err)
	}
	source, metadata := vaultFixture(t)
	metadata.CreatedAt = backup.Archive.Manifest.CreatedAt
	metadata.AppVersion = backup.Archive.Manifest.AppVersion
	metadata.Files = backup.Archive.Manifest.Files
	metadata.Bytes = backup.Archive.Manifest.Bytes
	if err := source.Save(t.Context(), bytes.NewReader(archive.Bytes()), metadata); err != nil {
		t.Fatal(err)
	}
	var encrypted bytes.Buffer
	exported, err := NewPortable(source).Export(t.Context(), metadata.ID, "isolated agent backup passphrase", &encrypted)
	if err != nil || exported.Files != 2 || exported.Bytes != int64(len(cliFixtureState)+len(content)) {
		t.Fatal("portable recount lost agent data or retained credentials", err)
	}
	destination, _ := vaultFixture(t)
	imported, err := NewPortable(destination).Import(t.Context(), bytes.NewReader(encrypted.Bytes()), "isolated agent backup passphrase")
	if err != nil || imported != exported {
		t.Fatal("scoped portable backup failed import", err)
	}
	opened, err := destination.Open(t.Context(), imported.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Reader.Close()
	validated, err := ValidateArchive(t.Context(), opened.Reader, t.TempDir())
	if err != nil || validated.Manifest.Scope != AgentDataScope || validated.Manifest.SchemaVersion != AgentDataSchemaVersion {
		t.Fatal("portable transform lost the authoritative scope marker", err)
	}
	actual, err := os.ReadFile(filepath.Join(validated.Directory, "workspace", testRestoreID, ".agents", "skills", "asset.png"))
	if err != nil || !bytes.Equal(actual, content) {
		t.Fatal("portable backup changed skill image bytes", err)
	}
	if _, err := os.Lstat(filepath.Join(validated.Directory, "data", "voice-key.dpapi")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("portable backup retained credentials", err)
	}
}

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
