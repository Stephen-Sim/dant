package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/google/uuid"
)

const (
	MaxAttachmentBytes          = 10 * 1024 * 1024
	MaxMessageAttachments       = 5
	MaxAttachmentNameCharacters = 240
	MaxAttachmentMetadataBytes  = 4096
)

var (
	ErrAttachment        = errors.New("invalid_attachment")
	ErrAttachmentMissing = errors.New("attachment_not_found")
	attachmentID         = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	attachmentBase64     = regexp.MustCompile(`^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`)
)

type Attachment = contracts.Attachment

type AttachmentStore struct{ directory string }

func OpenAttachmentStore(directory string) (*AttachmentStore, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return nil, ErrManagedPath
	}
	absolute, err = OrdinaryDirectory(absolute, true)
	if err != nil {
		return nil, err
	}
	return &AttachmentStore{directory: absolute}, nil
}

func (store *AttachmentStore) Directory() string { return store.directory }

// InspectContent trusts bounded bytes, never a client-provided MIME type.
func InspectContent(data []byte, name string) (string, error) {
	if len(data) > MaxAttachmentBytes {
		return "", ErrFileLimit
	}
	at := func(signature []byte, offset int) bool {
		return len(data) >= offset+len(signature) && bytes.Equal(data[offset:offset+len(signature)], signature)
	}
	switch {
	case at([]byte{137, 80, 78, 71, 13, 10, 26, 10}, 0):
		return "image/png", nil
	case at([]byte{255, 216, 255}, 0):
		return "image/jpeg", nil
	case at([]byte("GIF87a"), 0) || at([]byte("GIF89a"), 0):
		return "image/gif", nil
	case at([]byte("RIFF"), 0) && at([]byte("WEBP"), 8):
		return "image/webp", nil
	case at([]byte("%PDF-"), 0):
		return "application/pdf", nil
	case at([]byte("RIFF"), 0) && at([]byte("WAVE"), 8):
		return "audio/wav", nil
	case at([]byte("OggS"), 0):
		return "audio/ogg", nil
	case at([]byte("ID3"), 0) || (len(data) > 1 && data[0] == 255 && data[1]&224 == 224):
		return "audio/mpeg", nil
	case at([]byte{26, 69, 223, 163}, 0):
		return "audio/webm", nil
	case at([]byte{'P', 'K', 3, 4}, 0):
		return "application/zip", nil
	}
	jsonName := strings.EqualFold(filepath.Ext(name), ".json")
	if !utf8.Valid(data) {
		if jsonName {
			return "", ErrAttachment
		}
		return "application/octet-stream", nil
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return "application/octet-stream", nil
	}
	if jsonName {
		if !json.Valid(data) {
			return "", ErrAttachment
		}
		return "application/json", nil
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".svg", ".html", ".htm":
		return "application/octet-stream", nil
	}
	for _, value := range data {
		if (value >= 1 && value <= 8) || value == 11 || value == 12 || (value >= 14 && value <= 31) {
			return "application/octet-stream", nil
		}
	}
	return "text/plain", nil
}

func attachmentName(value string) string {
	value = path.Base(strings.ReplaceAll(value, `\`, "/"))
	var result strings.Builder
	units := 0
	for _, character := range value {
		if character <= 31 || character == 127 {
			continue
		}
		count := 1
		if character > 0xffff {
			count = 2
		}
		if units+count > MaxAttachmentNameCharacters {
			break
		}
		result.WriteRune(character)
		units += count
	}
	if result.Len() == 0 || result.String() == "." {
		return "file"
	}
	return result.String()
}

func (store *AttachmentStore) PutBase64(ctx context.Context, name, declaredType, encoded string) (Attachment, error) {
	if len(encoded) > ((MaxAttachmentBytes+2)/3)*4 || !attachmentBase64.MatchString(encoded) {
		return Attachment{}, ErrAttachment
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return Attachment{}, ErrAttachment
	}
	return store.Put(ctx, name, declaredType, data)
}

func writeExclusive(name string, data []byte) (fs.FileInfo, error) {
	file, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	info, statErr := file.Stat()
	closeErr := file.Close()
	if err != nil {
		return info, err
	}
	if statErr != nil {
		return info, statErr
	}
	if closeErr != nil {
		return info, closeErr
	}
	return info, nil
}

func removeOwned(name string, identity fs.FileInfo) {
	if identity == nil {
		return
	}
	if current, err := os.Lstat(name); err == nil && os.SameFile(identity, current) {
		_ = os.Remove(name)
	}
}

func (store *AttachmentStore) Put(ctx context.Context, name, declaredType string, data []byte) (Attachment, error) {
	if err := ctx.Err(); err != nil {
		return Attachment{}, err
	}
	if _, err := OrdinaryDirectory(store.directory, false); err != nil {
		return Attachment{}, err
	}
	name = attachmentName(name)
	actualType, err := InspectContent(data, name)
	if err != nil {
		return Attachment{}, err
	}
	if strings.HasPrefix(declaredType, "image/") || strings.HasPrefix(declaredType, "audio/") {
		category := strings.SplitN(declaredType, "/", 2)[0] + "/"
		if !strings.HasPrefix(actualType, category) {
			return Attachment{}, ErrAttachment
		}
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return Attachment{}, ErrAttachment
	}
	nameOnDisk := filepath.Join(store.directory, id.String()+".bin")
	digest := sha256.Sum256(data)
	meta := Attachment{
		ID:        id.String(),
		Name:      name,
		Type:      actualType,
		Size:      contracts.Some(float64(len(data))),
		Hash:      hex.EncodeToString(digest[:]),
		GuestPath: nameOnDisk,
	}
	identity, err := writeExclusive(nameOnDisk, data)
	if err != nil {
		removeOwned(nameOnDisk, identity)
		return Attachment{}, err
	}
	encoded, err := json.Marshal(meta)
	if err != nil {
		removeOwned(nameOnDisk, identity)
		return Attachment{}, ErrAttachment
	}
	metaPath := filepath.Join(store.directory, id.String()+".json")
	metaIdentity, err := writeExclusive(metaPath, encoded)
	if err != nil {
		removeOwned(nameOnDisk, identity)
		removeOwned(metaPath, metaIdentity)
		return Attachment{}, err
	}
	return meta, nil
}

func (store *AttachmentStore) Get(ctx context.Context, id string) (*Attachment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !attachmentID.MatchString(id) {
		return nil, nil
	}
	data, err := ReadRegular(filepath.Join(store.directory, id+".json"), MaxAttachmentMetadataBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	object, err := contracts.DecodeObject(data, MaxAttachmentMetadataBytes)
	if err != nil {
		return nil, nil
	}
	for _, name := range []string{"id", "name", "type", "hash"} {
		token := object[name]
		if len(token) < 2 || token[0] != '"' {
			return nil, nil
		}
	}
	if len(object["size"]) == 0 || string(object["size"]) == "null" {
		return nil, nil
	}
	var meta Attachment
	if json.Unmarshal(data, &meta) != nil || meta.ID != id {
		return nil, nil
	}
	size, valid := meta.Size.Get()
	if !valid || math.IsNaN(size) || math.IsInf(size, 0) || size < 0 || size > MaxAttachmentBytes || math.Trunc(size) != size {
		return nil, nil
	}
	return &Attachment{
		ID:         meta.ID,
		Name:       meta.Name,
		Type:       meta.Type,
		Size:       meta.Size,
		Hash:       meta.Hash,
		GuestPath:  filepath.Join(store.directory, id+".bin"),
		LegacyText: meta.LegacyText,
	}, nil
}

func (store *AttachmentStore) Read(ctx context.Context, id string) (Attachment, []byte, error) {
	meta, err := store.Get(ctx, id)
	if err != nil {
		return Attachment{}, nil, err
	}
	if meta == nil {
		return Attachment{}, nil, ErrAttachmentMissing
	}
	data, err := ReadRegular(meta.GuestPath, MaxAttachmentBytes)
	if err != nil {
		return Attachment{}, nil, err
	}
	if float64(len(data)) != meta.Size.Value {
		return Attachment{}, nil, ErrFileChanged
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != meta.Hash {
		return Attachment{}, nil, ErrFileChanged
	}
	return *meta, data, nil
}
