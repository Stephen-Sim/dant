package backups

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/platform"
)

const localMagic = "DANT-LOCAL-BACKUP/1\n"
const localHeaderLimit = 64 * 1024
const CatalogLimit = 1000

var backupID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var backupVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?$`)
var backupSource = regexp.MustCompile(`^[0-9a-f]{12}$`)
var wrappedHexKey = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
var ErrProtectionUnavailable = errors.New("backup_protection_unavailable")
var ErrExists = errors.New("backup_exists")
var ErrCatalogLimit = errors.New("backup_catalog_limit")

type Metadata struct {
	ID         string `json:"id"`
	CreatedAt  int64  `json:"createdAt"`
	AppVersion string `json:"appVersion"`
	Bytes      int64  `json:"bytes"`
	Files      int    `json:"files"`
	Source     string `json:"source"`
}

func (metadata Metadata) Valid() bool {
	return backupID.MatchString(metadata.ID) && metadata.CreatedAt > 0 && metadata.CreatedAt <= 9007199254740991 && backupVersion.MatchString(metadata.AppVersion) && metadata.Bytes >= 0 && metadata.Bytes <= MaxBackupBytes && metadata.Files >= 0 && metadata.Files <= MaxFiles && backupSource.MatchString(metadata.Source)
}

type localHeader struct {
	Schema     int      `json:"schema"`
	Metadata   Metadata `json:"metadata"`
	WrappedKey string   `json:"wrappedKey"`
	IV         string   `json:"iv"`
}

type HeaderInfo struct {
	Metadata     Metadata
	ArchiveBytes int64
}

type VaultOptions struct {
	DataDir    string
	Protection platform.SecretProtection
	Executable string
	Transform  func(context.Context, TransformRequest) error
}

type Vault struct {
	directory  string
	staging    string
	protection platform.SecretProtection
	transform  func(context.Context, TransformRequest) error
	entropy    io.Reader
	create     func(string, int, fs.FileMode) (vaultWriteFile, error)
}

type vaultWriteFile interface {
	Write([]byte) (int, error)
	Stat() (fs.FileInfo, error)
	Truncate(int64) error
	Sync() error
	Close() error
}

type inspectedBackup struct {
	file         *os.File
	stat         os.FileInfo
	header       localHeader
	aad          []byte
	start        int64
	archiveBytes int64
}

type privateStage struct {
	file     string
	identity os.FileInfo
}

func NewID() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		panic("host entropy unavailable")
	}
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

func NewVault(options VaultOptions) (*Vault, error) {
	if !filepath.IsAbs(options.DataDir) {
		return nil, ErrInvalid
	}
	directory, err := files.OrdinaryDirectory(filepath.Join(options.DataDir, "vm-backups"), true)
	if err != nil {
		return nil, ErrInvalid
	}
	staging, err := files.OrdinaryDirectory(filepath.Join(options.DataDir, "backup-transforms"), true)
	if err != nil {
		return nil, ErrInvalid
	}

	if options.Transform == nil {
		executable := options.Executable
		if executable == "" {
			executable, err = os.Executable()
			if err != nil {
				return nil, ErrInvalid
			}
		}
		options.Transform = func(ctx context.Context, request TransformRequest) error { return Transform(ctx, executable, request) }
	}

	return &Vault{
		directory:  directory,
		staging:    staging,
		protection: options.Protection,
		transform:  options.Transform,
		entropy:    rand.Reader,
		create: func(name string, flags int, mode fs.FileMode) (vaultWriteFile, error) {
			return os.OpenFile(name, flags, mode)
		},
	}, nil
}

func (vault *Vault) Protected() bool { return vault.protection != nil }
func (vault *Vault) file(id string) (string, error) {
	if !backupID.MatchString(id) {
		return "", ErrInvalid
	}

	if _, err := files.OrdinaryDirectory(vault.directory, false); err != nil {
		return "", ErrInvalid
	}

	return filepath.Join(vault.directory, id+".dantbak"), nil
}

func cleanStage(stage privateStage) error {
	stat, err := os.Lstat(stage.file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}

	if err != nil || !stat.Mode().IsRegular() || !os.SameFile(stage.identity, stat) {
		return ErrSourceChanged
	}

	return os.Remove(stage.file)
}

func copyBounded(ctx context.Context, output io.Writer, input io.Reader, maximum int64) (int64, error) {
	buffer := make([]byte, ChunkBytes)
	var copied int64
	emptyReads := 0
	for {
		if err := ctx.Err(); err != nil {
			return copied, err
		}
		length, err := input.Read(buffer)
		if length > 0 {
			emptyReads = 0
			copied += int64(length)
			if copied > maximum {
				return copied, ErrSizeLimit
			}
			written, writeErr := output.Write(buffer[:length])
			if writeErr != nil {
				return copied, writeErr
			}
			if written != length {
				return copied, io.ErrShortWrite
			}
		}
		if length == 0 && err == nil {
			emptyReads++
			if emptyReads >= 100 {
				return copied, io.ErrNoProgress
			}
		}
		if errors.Is(err, io.EOF) {
			return copied, nil
		}
		if err != nil {
			return copied, err
		}
	}
}

func (vault *Vault) stage(ctx context.Context, input io.Reader, reserve bool) (privateStage, int64, error) {
	if _, err := files.OrdinaryDirectory(vault.staging, false); err != nil {
		return privateStage{}, 0, ErrInvalid
	}
	name, _ := stageName(vault.staging, NewID())
	file, err := vault.create(name, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return privateStage{}, 0, ErrInvalid
	}
	identity, err := file.Stat()
	if err != nil {
		file.Close()
		// A reused name cannot be cleaned up without the captured file identity.
		return privateStage{}, 0, ErrInvalid
	}
	stage := privateStage{file: name, identity: identity}
	keep := false
	closed := false
	defer func() {
		if !closed {
			file.Close()
		}
		if !keep {
			_ = cleanStage(stage)
		}
	}()
	limit := ArchiveLimit
	if !reserve {
		limit += gcmTagBytes
	}
	count, err := copyBounded(ctx, file, input, limit)
	if err != nil {
		return privateStage{}, 0, err
	}

	if count == 0 {
		return privateStage{}, 0, ErrInvalid
	}

	if reserve {
		if err := file.Truncate(count + gcmTagBytes); err != nil {
			return privateStage{}, 0, ErrInvalid
		}
	}

	if file.Sync() != nil {
		return privateStage{}, 0, ErrInvalid
	}
	err = file.Close()
	closed = true
	if err != nil {
		return privateStage{}, 0, ErrInvalid
	}
	keep = true
	return stage, count, nil
}

func (vault *Vault) inspect(id string) (inspectedBackup, error) {
	name, err := vault.file(id)
	if err != nil {
		return inspectedBackup{}, err
	}
	before, err := os.Lstat(name)
	if err != nil || !before.Mode().IsRegular() || before.Size() > ArchiveLimit+localHeaderLimit+int64(len(localMagic))+4+gcmTagBytes || before.Size() < int64(len(localMagic))+4+gcmTagBytes {
		return inspectedBackup{}, ErrInvalid
	}
	file, err := os.Open(name)
	if err != nil {
		return inspectedBackup{}, ErrInvalid
	}
	valid := false
	defer func() {
		if !valid {
			file.Close()
		}
	}()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) || !stageSingleLink(file) {
		return inspectedBackup{}, ErrInvalid
	}
	prefix := make([]byte, len(localMagic)+4)
	if _, err := io.ReadFull(file, prefix); err != nil || string(prefix[:len(localMagic)]) != localMagic {
		return inspectedBackup{}, ErrInvalid
	}
	length := binary.BigEndian.Uint32(prefix[len(localMagic):])
	if length == 0 || length > localHeaderLimit || int64(len(prefix))+int64(length)+gcmTagBytes > before.Size() {
		return inspectedBackup{}, ErrInvalid
	}
	aad := make([]byte, int(length))
	if _, err := io.ReadFull(file, aad); err != nil {
		return inspectedBackup{}, ErrInvalid
	}

	if _, err := contracts.DecodeObject(aad, localHeaderLimit); err != nil {
		return inspectedBackup{}, ErrInvalid
	}
	var header localHeader
	if json.Unmarshal(aad, &header) != nil || header.Schema != 1 || !header.Metadata.Valid() || header.Metadata.ID != id {
		return inspectedBackup{}, ErrInvalid
	}
	wrapped, err := base64.StdEncoding.Strict().DecodeString(header.WrappedKey)
	if err != nil || len(wrapped) == 0 || len(wrapped) > localHeaderLimit/2 {
		return inspectedBackup{}, ErrInvalid
	}
	iv, err := base64.StdEncoding.Strict().DecodeString(header.IV)
	if err != nil || len(iv) != gcmNonceBytes {
		return inspectedBackup{}, ErrInvalid
	}
	start := int64(len(prefix)) + int64(length)
	named, err := os.Lstat(name)
	if err != nil || !os.SameFile(before, named) || named.Size() != before.Size() || !named.ModTime().Equal(before.ModTime()) || !stageSingleLink(file) {
		return inspectedBackup{}, ErrSourceChanged
	}
	valid = true
	return inspectedBackup{file: file, stat: before, header: header, aad: aad, start: start, archiveBytes: before.Size() - start - gcmTagBytes}, nil
}

func (vault *Vault) ReadHeader(id string) (HeaderInfo, error) {
	inspection, err := vault.inspect(id)
	if err != nil {
		return HeaderInfo{}, err
	}
	defer inspection.file.Close()
	return HeaderInfo{Metadata: inspection.header.Metadata, ArchiveBytes: inspection.archiveBytes}, nil
}

func (vault *Vault) List() (metadata []Metadata, invalidCount int, err error) {
	if _, err := files.OrdinaryDirectory(vault.directory, false); err != nil {
		return nil, 0, ErrInvalid
	}
	identity, err := files.CaptureIdentity(vault.directory)
	if err != nil {
		return nil, 0, ErrInvalid
	}
	names, err := os.ReadDir(vault.directory)
	if err != nil {
		return nil, 0, ErrInvalid
	}

	if len(names) > CatalogLimit {
		return nil, 0, ErrCatalogLimit
	}
	metadata = []Metadata{}
	for _, name := range names {
		if filepath.Ext(name.Name()) != ".dantbak" {
			continue
		}
		header, readErr := vault.ReadHeader(stringsTrimBackupSuffix(name.Name()))
		if readErr != nil {
			invalidCount++
		} else {
			metadata = append(metadata, header.Metadata)
		}
		current, err := os.Lstat(vault.directory)
		if err != nil || !current.IsDir() || !os.SameFile(identity, current) {
			return nil, 0, ErrSourceChanged
		}
	}
	sort.SliceStable(metadata, func(left, right int) bool { return metadata[left].CreatedAt > metadata[right].CreatedAt })
	return metadata, invalidCount, nil
}

func stringsTrimBackupSuffix(name string) string { return name[:len(name)-len(".dantbak")] }
func (vault *Vault) Save(ctx context.Context, input io.Reader, metadata Metadata) error {
	if vault.protection == nil {
		return ErrProtectionUnavailable
	}

	if !metadata.Valid() {
		return ErrInvalid
	}
	destination, err := vault.file(metadata.ID)
	if err != nil {
		return err
	}

	if _, err := os.Lstat(destination); err == nil {
		return ErrExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrInvalid
	}
	key := make([]byte, gcmKeyBytes)
	defer clear(key)
	nonce := make([]byte, gcmNonceBytes)
	if _, err := io.ReadFull(vault.entropy, key); err != nil {
		return ErrInvalid
	}
	if _, err := io.ReadFull(vault.entropy, nonce); err != nil {
		return ErrInvalid
	}
	keyText := []byte(hex.EncodeToString(key))
	wrapped, err := vault.protection.Protect(ctx, keyText)
	clear(keyText)
	if err != nil {
		return ErrProtectionUnavailable
	}
	header := localHeader{Schema: 1, Metadata: metadata, WrappedKey: base64.StdEncoding.EncodeToString(wrapped), IV: base64.StdEncoding.EncodeToString(nonce)}
	aad, err := json.Marshal(header)
	if err != nil || len(aad) > localHeaderLimit {
		return ErrInvalid
	}
	stage, count, err := vault.stage(ctx, input, true)
	if err != nil {
		return err
	}
	defer cleanStage(stage)
	if err := vault.transform(ctx, TransformRequest{Directory: vault.staging, File: stage.file, Mode: "encrypt", Bytes: count, Key: key, Nonce: nonce, AAD: aad}); err != nil {
		return err
	}
	temporary := filepath.Join(vault.directory, "."+NewID()+".partial")
	output, err := vault.create(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return ErrInvalid
	}
	outputIdentity, err := output.Stat()
	if err != nil {
		output.Close()
		return ErrInvalid
	}
	publication := privateStage{file: temporary, identity: outputIdentity}
	defer func() {
		output.Close()
		_ = cleanStage(publication)
	}()
	prefix := make([]byte, len(localMagic)+4)
	copy(prefix, localMagic)
	binary.BigEndian.PutUint32(prefix[len(localMagic):], uint32(len(aad)))
	if _, err := output.Write(prefix); err != nil {
		return ErrInvalid
	}

	if _, err := output.Write(aad); err != nil {
		return ErrInvalid
	}
	ciphertext, err := openPrivateStage(stage, count+gcmTagBytes)
	if err != nil {
		return ErrInvalid
	}
	copied, err := copyBounded(ctx, output, ciphertext, count+gcmTagBytes)
	ciphertext.Close()
	if err != nil || copied != count+gcmTagBytes {
		return ErrInvalid
	}

	if output.Sync() != nil {
		return ErrInvalid
	}
	written, err := output.Stat()
	if err != nil || !os.SameFile(outputIdentity, written) || written.Size() != int64(len(prefix)+len(aad))+count+gcmTagBytes || output.Close() != nil {
		return ErrInvalid
	}

	if err := files.RenameManagedFile(ctx, temporary, destination, written); err != nil {
		return ErrInvalid
	}

	return nil
}

type OpenedBackup struct {
	Metadata     Metadata
	ArchiveBytes int64
	Reader       io.ReadCloser
}

type stageReader struct {
	*os.File
	stage privateStage
}

func (reader *stageReader) Close() error {
	err := reader.File.Close()
	cleanup := cleanStage(reader.stage)
	if err != nil && !errors.Is(err, os.ErrClosed) {
		return err
	}

	return cleanup
}

func (vault *Vault) Open(ctx context.Context, id string) (OpenedBackup, error) {
	if vault.protection == nil {
		return OpenedBackup{}, ErrProtectionUnavailable
	}
	inspection, err := vault.inspect(id)
	if err != nil {
		return OpenedBackup{}, err
	}
	defer inspection.file.Close()
	wrapped, _ := base64.StdEncoding.Strict().DecodeString(inspection.header.WrappedKey)
	keyText, err := vault.protection.Unprotect(ctx, wrapped)
	if err != nil {
		return OpenedBackup{}, ErrProtectionUnavailable
	}
	defer clear(keyText)
	if !wrappedHexKey.Match(keyText) {
		return OpenedBackup{}, ErrInvalid
	}
	key, err := hex.DecodeString(string(keyText))
	if err != nil || len(key) != gcmKeyBytes {
		return OpenedBackup{}, ErrInvalid
	}
	defer clear(key)
	nonce, _ := base64.StdEncoding.Strict().DecodeString(inspection.header.IV)
	stage, count, err := vault.stage(ctx, io.NewSectionReader(inspection.file, inspection.start, inspection.archiveBytes+gcmTagBytes), false)
	if err != nil {
		return OpenedBackup{}, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = cleanStage(stage)
		}
	}()
	if count != inspection.archiveBytes+gcmTagBytes {
		return OpenedBackup{}, ErrInvalid
	}
	named, err := os.Lstat(inspection.file.Name())
	if err != nil || !os.SameFile(inspection.stat, named) || inspection.stat.Size() != named.Size() || !inspection.stat.ModTime().Equal(named.ModTime()) {
		return OpenedBackup{}, ErrSourceChanged
	}

	if err := vault.transform(ctx, TransformRequest{Directory: vault.staging, File: stage.file, Mode: "decrypt", Bytes: inspection.archiveBytes, Key: key, Nonce: nonce, AAD: inspection.aad}); err != nil {
		return OpenedBackup{}, err
	}
	plaintext, err := openPrivateStage(stage, inspection.archiveBytes)
	if err != nil {
		return OpenedBackup{}, ErrInvalid
	}
	keep = true
	return OpenedBackup{Metadata: inspection.header.Metadata, ArchiveBytes: inspection.archiveBytes, Reader: &stageReader{File: plaintext, stage: stage}}, nil
}

func (vault *Vault) Retain(ctx context.Context, count int) error {
	if count < 1 || count > 100 {
		return ErrInvalid
	}
	backups, _, err := vault.List()
	if err != nil {
		return err
	}
	retained := map[string]int{}
	for _, backup := range backups {
		retained[backup.Source]++
		if retained[backup.Source] <= count {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		inspection, err := vault.inspect(backup.ID)
		if err != nil {
			return err
		}
		name := inspection.file.Name()
		inspection.file.Close()
		if err := os.Remove(name); err != nil {
			return ErrInvalid
		}
	}

	return nil
}

func openPrivateStage(stage privateStage, size int64) (*os.File, error) {
	if _, err := files.OrdinaryDirectory(filepath.Dir(stage.file), false); err != nil {
		return nil, ErrInvalid
	}
	before, err := os.Lstat(stage.file)
	if err != nil || !before.Mode().IsRegular() || !os.SameFile(stage.identity, before) || before.Size() != size {
		return nil, ErrSourceChanged
	}
	file, err := os.Open(stage.file)
	if err != nil {
		return nil, ErrInvalid
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) || opened.Size() != size || !stageSingleLink(file) {
		file.Close()
		return nil, ErrSourceChanged
	}

	return file, nil
}
