package legacyimport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

type source struct {
	root        *files.ManagedRoot
	manifest    contracts.RawObject
	state       contracts.RawObject
	manifestRaw []byte
	stateRaw    []byte
	id          string
	files       []sourceFile
}

func hash(data []byte) string {
	value := sha256.Sum256(data)
	return hex.EncodeToString(value[:])
}

func text(raw json.RawMessage) (string, bool) {
	var value string
	if len(raw) == 0 || raw[0] != '"' || !contracts.ValidUnicodeJSON(raw) || json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func objects(raw json.RawMessage, optional bool) ([]contracts.RawObject, error) {
	if raw == nil && optional {
		return []contracts.RawObject{}, nil
	}
	var values []json.RawMessage
	if len(raw) == 0 || raw[0] != '[' || json.Unmarshal(raw, &values) != nil || len(values) > maxLegacyReferences {
		return nil, ErrInvalid
	}
	result := make([]contracts.RawObject, 0, len(values))
	for _, value := range values {
		object, err := contracts.DecodeObject(value, stateMaxBytes)
		if err != nil {
			return nil, ErrInvalid
		}
		result = append(result, object)
	}
	return result, nil
}

func readSource(ctx context.Context, directory string) (*source, error) {
	root, err := files.OpenManagedRoot(directory, false)
	if err != nil {
		return nil, ErrInvalid
	}
	value := &source{root: root, files: []sourceFile{}}
	failed := true
	defer func() {
		if failed {
			_ = root.Close()
		}
	}()
	value.manifestRaw, err = root.ReadFile(ctx, manifestName, manifestMaxBytes)
	if errors.Is(err, os.ErrNotExist) {
		failed = false
		return value, nil
	}
	if err != nil {
		return nil, ErrInvalid
	}
	value.manifest, err = contracts.DecodeObject(value.manifestRaw, manifestMaxBytes)
	if err != nil {
		return nil, ErrInvalid
	}
	value.id, _ = text(value.manifest["id"])
	if value.id == "" || contracts.UTF16Length(value.id) > maxManifestIDUnits || strings.ContainsAny(value.id, "\x00\r\n") {
		return nil, ErrInvalid
	}
	value.stateRaw, err = root.ReadFile(ctx, stateName, stateMaxBytes)
	if err != nil {
		return nil, ErrInvalid
	}
	value.state, err = contracts.DecodeObject(value.stateRaw, stateMaxBytes)
	if err != nil {
		return nil, ErrInvalid
	}
	messages, err := objects(value.state["messages"], true)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var total int64
	references := 0
	for _, message := range messages {
		attachments, err := objects(message["attachments"], true)
		if err != nil {
			return nil, err
		}
		references += len(attachments)
		if references > maxLegacyReferences {
			return nil, ErrCapacity
		}
		for _, attachment := range attachments {
			id, valid := text(attachment["id"])
			if !valid || len(id) > maxLegacyIDBytes || !legacyID.MatchString(id) {
				return nil, ErrInvalid
			}
			if seen[id] {
				continue
			}
			seen[id] = true
			if len(seen) > maxLegacyFiles {
				return nil, ErrCapacity
			}
			name := "file"
			if raw, exists := attachment["name"]; exists {
				var ok bool
				name, ok = text(raw)
				if !ok {
					return nil, ErrInvalid
				}
			}
			entry := sourceFile{ID: id, Name: safeName(name)}
			digest, size, err := root.Digest(ctx, filepath.Join("files", id), maxFileBytes)
			if errors.Is(err, os.ErrNotExist) {
				entry.Unavailable = true
			} else if err != nil {
				if errors.Is(err, files.ErrFileLimit) {
					return nil, ErrCapacity
				}
				return nil, ErrInvalid
			} else {
				entry.SHA256, entry.Bytes = digest, size
				total += size
				if total > maxTotalFileBytes {
					return nil, ErrCapacity
				}
			}
			value.files = append(value.files, entry)
		}
	}
	if _, err := value.transform(nil, nil); err != nil {
		return nil, err
	}
	failed = false
	return value, nil
}

func (value *source) unchanged(ctx context.Context) error {
	for _, item := range []struct {
		name  string
		limit int64
		sha   string
	}{
		{manifestName, manifestMaxBytes, hash(value.manifestRaw)},
		{stateName, stateMaxBytes, hash(value.stateRaw)},
	} {
		digest, _, err := value.root.Digest(ctx, item.name, item.limit)
		if err != nil || digest != item.sha {
			return ErrChanged
		}
	}
	for _, item := range value.files {
		digest, size, err := value.root.Digest(ctx, filepath.Join("files", item.ID), maxFileBytes)
		if item.Unavailable {
			if !errors.Is(err, os.ErrNotExist) {
				return ErrChanged
			}
		} else if err != nil || digest != item.SHA256 || size != item.Bytes {
			return ErrChanged
		}
	}
	if !value.root.Unchanged() {
		return ErrChanged
	}
	return ctx.Err()
}
