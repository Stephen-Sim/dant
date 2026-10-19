package backups

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"golang.org/x/crypto/scrypt"
)

const portableMagic = "DANT-PORTABLE-BACKUP/1\n"
const portableHeaderLimit = 8192
const portableSaltBytes = 32
const portablePassphraseMinBytes = 12
const PortablePassphraseMaxBytes = 1024
const PortableMaxFileBytes = ArchiveLimit + portableHeaderLimit + int64(len(portableMagic)) + 4 + gcmTagBytes
const scryptN = 65536
const scryptR = 8
const scryptP = 1

var ErrPassphrase = errors.New("backup_passphrase_invalid")
var ErrBusy = errors.New("backup_busy")
var deriving = make(chan struct{}, 1)

type portableKDF struct {
	Name string `json:"name"`
	N    int    `json:"N"`
	R    int    `json:"r"`
	P    int    `json:"p"`
	Salt string `json:"salt"`
}

type portableHeader struct {
	Schema       int         `json:"schema"`
	Cipher       string      `json:"cipher"`
	KDF          portableKDF `json:"kdf"`
	IV           string      `json:"iv"`
	Metadata     Metadata    `json:"metadata"`
	ArchiveBytes int64       `json:"archiveBytes"`
}

type Portable struct{ vault *Vault }

func NewPortable(vault *Vault) *Portable { return &Portable{vault: vault} }
func portablePassword(value string) ([]byte, error) {
	if len(value) < portablePassphraseMinBytes || len(value) > PortablePassphraseMaxBytes {
		return nil, ErrPassphrase
	}

	return []byte(value), nil
}

func portableKey(ctx context.Context, secret, salt []byte) ([]byte, error) {
	select {
	case deriving <- struct{}{}:
		defer func() { <-deriving }()
	default:
		return nil, ErrBusy
	}

	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key, err := scrypt.Key(secret, salt, scryptN, scryptR, scryptP, gcmKeyBytes)
	if err != nil {
		return nil, ErrInvalid
	}

	if err := ctx.Err(); err != nil {
		clear(key)
		return nil, err
	}

	return key, nil
}

func strictBase64(value string, size int) ([]byte, error) {
	if len(value) != base64.StdEncoding.EncodedLen(size) {
		return nil, ErrInvalid
	}
	result, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(result) != size || base64.StdEncoding.EncodeToString(result) != value {
		return nil, ErrInvalid
	}

	return result, nil
}

func portableHeaderBytes(header portableHeader) ([]byte, error) {
	raw, err := json.Marshal(header)
	if err != nil || len(raw) > portableHeaderLimit {
		return nil, ErrInvalid
	}
	prefix := make([]byte, len(portableMagic)+4)
	copy(prefix, portableMagic)
	binary.BigEndian.PutUint32(prefix[len(portableMagic):], uint32(len(raw)))
	return append(prefix, raw...), nil
}

func readPortableHeader(input io.Reader) (portableHeader, []byte, error) {
	prefix := make([]byte, len(portableMagic)+4)
	if _, err := io.ReadFull(input, prefix); err != nil || string(prefix[:len(portableMagic)]) != portableMagic {
		return portableHeader{}, nil, ErrInvalid
	}
	length := binary.BigEndian.Uint32(prefix[len(portableMagic):])
	if length == 0 || length > portableHeaderLimit {
		return portableHeader{}, nil, ErrInvalid
	}
	raw := make([]byte, int(length))
	if _, err := io.ReadFull(input, raw); err != nil {
		return portableHeader{}, nil, ErrInvalid
	}
	object, err := contracts.DecodeObject(raw, portableHeaderLimit)
	if err != nil || len(object) != 6 || !required(object, "schema", "cipher", "kdf", "iv", "metadata", "archiveBytes") {
		return portableHeader{}, nil, ErrInvalid
	}
	kdf, err := contracts.DecodeObject(object["kdf"], portableHeaderLimit)
	if err != nil || len(kdf) != 5 || !required(kdf, "name", "N", "r", "p", "salt") {
		return portableHeader{}, nil, ErrInvalid
	}
	metadata, err := contracts.DecodeObject(object["metadata"], portableHeaderLimit)
	if err != nil || len(metadata) != 6 || !required(metadata, "id", "createdAt", "appVersion", "bytes", "files", "source") {
		return portableHeader{}, nil, ErrInvalid
	}
	var header portableHeader
	if json.Unmarshal(raw, &header) != nil || header.Schema != 1 || header.Cipher != "aes-256-gcm" || header.KDF.Name != "scrypt" || header.KDF.N != scryptN || header.KDF.R != scryptR || header.KDF.P != scryptP || !header.Metadata.Valid() || header.ArchiveBytes <= 0 {
		return portableHeader{}, nil, ErrInvalid
	}

	if header.ArchiveBytes > ArchiveLimit {
		return portableHeader{}, nil, ErrSizeLimit
	}

	if _, err := strictBase64(header.KDF.Salt, portableSaltBytes); err != nil {
		return portableHeader{}, nil, err
	}

	if _, err := strictBase64(header.IV, gcmNonceBytes); err != nil {
		return portableHeader{}, nil, err
	}

	return header, append(prefix, raw...), nil
}

func authenticationPath(domain, relative string) bool {
	parts := strings.Split(strings.ToLower(relative), "/")
	name := parts[len(parts)-1]
	for _, part := range parts {
		switch part {
		case ".ssh", ".codex", ".openai", ".aws", ".azure", ".gnupg":
			return true
		}
	}

	if name == ".env" || (strings.HasPrefix(name, ".env.") && name != ".env.example") {
		return true
	}

	if domain == "data" {
		if parts[0] == "credentials" {
			return true
		}
		if len(parts) == 1 {
			switch name {
			case "telegram.json", "voice-key.dpapi", "auth.json", "credentials.json", "secrets.json", "master.key", "vm-key", "vm.json", ".dant-core-owner.lock":
				return true
			}
			return strings.HasPrefix(name, "voice-key") || strings.HasPrefix(name, "telegram-token") || strings.HasPrefix(name, "telegram-key")
		}
		return false
	}
	for index, part := range parts {
		if part == ".git" && len(parts) == index+2 && (name == "config" || name == "credentials") {
			return true
		}
	}
	switch name {
	case "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", ".netrc", ".npmrc", ".pypirc":
		return true
	}

	return false
}

func matchesMetadata(manifest Manifest, metadata Metadata) bool {
	return manifest.CreatedAt == metadata.CreatedAt && manifest.AppVersion == metadata.AppVersion && manifest.Files == metadata.Files && manifest.Bytes == metadata.Bytes
}

func extractionDirectory(parent string) (string, os.FileInfo, error) {
	directory, err := os.MkdirTemp(parent, ".portable-extract-")
	if err != nil {
		return "", nil, ErrInvalid
	}
	identity, err := os.Lstat(directory)
	if err != nil {
		return "", nil, ErrInvalid
	}

	return directory, identity, nil
}

func cleanupExtraction(parent, directory string, identity os.FileInfo) error {
	relative, err := filepath.Rel(parent, directory)
	if err != nil || filepath.IsAbs(relative) || filepath.Base(relative) != relative || !strings.HasPrefix(relative, ".portable-extract-") {
		return ErrInvalid
	}
	current, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}

	if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(identity, current) {
		return ErrSourceChanged
	}

	return os.RemoveAll(directory)
}

type boundedFileWriter struct {
	file  *os.File
	count int64
}

func (writer *boundedFileWriter) Write(value []byte) (int, error) {
	if writer.count+int64(len(value)) > ArchiveLimit {
		return 0, ErrSizeLimit
	}
	length, err := writer.file.Write(value)
	writer.count += int64(length)
	return length, err
}

func (portable *Portable) Export(ctx context.Context, id, passphrase string, output io.Writer) (Metadata, error) {
	secret, err := portablePassword(passphrase)
	if err != nil {
		return Metadata{}, err
	}
	defer clear(secret)
	opened, err := portable.vault.Open(ctx, id)
	if err != nil {
		return Metadata{}, err
	}
	defer opened.Reader.Close()
	directory, identity, err := extractionDirectory(portable.vault.staging)
	if err != nil {
		return Metadata{}, err
	}
	defer cleanupExtraction(portable.vault.staging, directory, identity)
	archive, err := ValidateArchive(ctx, opened.Reader, directory)
	if err != nil || !matchesMetadata(archive.Manifest, opened.Metadata) {
		return Metadata{}, ErrInvalid
	}
	retained := []ArchiveEntry{}
	manifest := archive.Manifest
	manifest.Files = 0
	manifest.Bytes = 0
	for _, entry := range archive.Entries {
		if authenticationPath(entry.Domain, entry.Path) {
			continue
		}
		retained = append(retained, entry)
		if !entry.Directory {
			manifest.Files++
			manifest.Bytes += entry.Size
		}
	}
	archive.Manifest = manifest
	archive.Entries = retained
	metadata := opened.Metadata
	metadata.Files = manifest.Files
	metadata.Bytes = manifest.Bytes
	name, _ := stageName(portable.vault.staging, NewID())
	file, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return Metadata{}, ErrInvalid
	}
	stat, err := file.Stat()
	if err != nil {
		file.Close()
		os.Remove(name)
		return Metadata{}, ErrInvalid
	}
	stage := privateStage{file: name, identity: stat}
	defer cleanStage(stage)
	writer := &boundedFileWriter{file: file}
	if err := WriteArchive(ctx, writer, archive); err != nil {
		file.Close()
		return Metadata{}, err
	}

	if err := file.Truncate(writer.count + gcmTagBytes); err != nil {
		file.Close()
		return Metadata{}, ErrInvalid
	}

	if file.Sync() != nil || file.Close() != nil {
		return Metadata{}, ErrInvalid
	}
	salt := make([]byte, portableSaltBytes)
	nonce := make([]byte, gcmNonceBytes)
	if _, err := rand.Read(salt); err != nil {
		return Metadata{}, ErrInvalid
	}

	if _, err := rand.Read(nonce); err != nil {
		return Metadata{}, ErrInvalid
	}
	key, err := portableKey(ctx, secret, salt)
	if err != nil {
		return Metadata{}, err
	}
	defer clear(key)
	header := portableHeader{
		Schema: 1,
		Cipher: "aes-256-gcm",
		KDF: portableKDF{
			Name: "scrypt", N: scryptN, R: scryptR, P: scryptP,
			Salt: base64.StdEncoding.EncodeToString(salt),
		},
		IV:           base64.StdEncoding.EncodeToString(nonce),
		Metadata:     metadata,
		ArchiveBytes: writer.count,
	}
	aad, err := portableHeaderBytes(header)
	if err != nil {
		return Metadata{}, err
	}

	if err := portable.vault.transform(ctx, TransformRequest{Directory: portable.vault.staging, File: name, Mode: "encrypt", Bytes: writer.count, Key: key, Nonce: nonce, AAD: aad}); err != nil {
		return Metadata{}, err
	}
	ciphertext, err := openPrivateStage(stage, writer.count+gcmTagBytes)
	if err != nil {
		return Metadata{}, ErrInvalid
	}
	defer ciphertext.Close()
	if _, err := output.Write(aad); err != nil {
		return Metadata{}, err
	}
	count, err := copyBounded(ctx, output, ciphertext, writer.count+gcmTagBytes)
	if err != nil || count != writer.count+gcmTagBytes {
		return Metadata{}, ErrInvalid
	}

	return metadata, nil
}

func (portable *Portable) Import(ctx context.Context, input io.Reader, passphrase string) (Metadata, error) {
	secret, err := portablePassword(passphrase)
	if err != nil {
		return Metadata{}, err
	}
	defer clear(secret)
	header, aad, err := readPortableHeader(input)
	if err != nil {
		return Metadata{}, err
	}
	stage, count, err := portable.vault.stage(ctx, io.LimitReader(input, header.ArchiveBytes+gcmTagBytes+1), false)
	if err != nil {
		return Metadata{}, err
	}
	defer cleanStage(stage)
	if count != header.ArchiveBytes+gcmTagBytes {
		return Metadata{}, ErrInvalid
	}
	salt, _ := strictBase64(header.KDF.Salt, portableSaltBytes)
	nonce, _ := strictBase64(header.IV, gcmNonceBytes)
	key, err := portableKey(ctx, secret, salt)
	if err != nil {
		return Metadata{}, err
	}
	defer clear(key)
	if err := portable.vault.transform(ctx, TransformRequest{Directory: portable.vault.staging, File: stage.file, Mode: "decrypt", Bytes: header.ArchiveBytes, Key: key, Nonce: nonce, AAD: aad}); err != nil {
		return Metadata{}, err
	}
	plaintext, err := openPrivateStage(stage, header.ArchiveBytes)
	if err != nil {
		return Metadata{}, ErrInvalid
	}
	defer plaintext.Close()
	directory, identity, err := extractionDirectory(portable.vault.staging)
	if err != nil {
		return Metadata{}, err
	}
	defer cleanupExtraction(portable.vault.staging, directory, identity)
	archive, err := ValidateArchive(ctx, plaintext, directory)
	if err != nil || !matchesMetadata(archive.Manifest, header.Metadata) {
		return Metadata{}, ErrInvalid
	}
	for _, entry := range archive.Entries {
		if authenticationPath(entry.Domain, entry.Path) {
			return Metadata{}, ErrInvalid
		}
	}

	if _, err := plaintext.Seek(0, io.SeekStart); err != nil {
		return Metadata{}, ErrInvalid
	}

	if err := portable.vault.Save(ctx, plaintext, header.Metadata); err != nil {
		return Metadata{}, err
	}

	return header.Metadata, nil
}
