package legacyimport

import (
	"context"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/google/uuid"
)

type destination struct {
	managed *files.ManagedRoot
	root    *os.Root
	create  func(string) (publicationFile, error)
}

func openDestination(directory string) (*destination, error) {
	managed, err := files.OpenManagedRoot(directory, false)
	if err != nil {
		return nil, ErrChanged
	}
	before, err := os.Lstat(directory)
	if err != nil {
		_ = managed.Close()
		return nil, ErrChanged
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		_ = managed.Close()
		return nil, ErrChanged
	}
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(before, opened) || !managed.Unchanged() {
		_ = root.Close()
		_ = managed.Close()
		return nil, ErrChanged
	}
	target := &destination{managed: managed, root: root}
	target.create = target.openExclusive
	return target, nil
}

func (target *destination) close() {
	_ = target.root.Close()
	_ = target.managed.Close()
}

func (target *destination) exclusive(ctx context.Context, name string, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if filepath.Base(name) != name || !target.managed.Unchanged() {
		return ErrChanged
	}
	file, err := target.create(name)
	if err != nil {
		return ErrUnconfirmed
	}
	closed := false
	defer func() {
		if !closed {
			_ = file.Close()
		}
	}()
	count, err := file.Write(data)
	if err != nil || count != len(data) {
		return ErrUnconfirmed
	}
	if err := file.Sync(); err != nil {
		return ErrUnconfirmed
	}
	info, err := file.Stat()
	current, statErr := target.root.Lstat(name)
	if err != nil || statErr != nil || !os.SameFile(info, current) ||
		!file.SingleLink() || !target.managed.Unchanged() {
		return ErrChanged
	}
	closed = true
	if err := file.Close(); err != nil {
		return ErrUnconfirmed
	}
	return syncDirectory(target.root)
}

func safeName(value string) string {
	value = path.Base(strings.ReplaceAll(value, `\`, "/"))
	var output strings.Builder
	units := 0
	for _, character := range value {
		if character <= 31 || character == 127 {
			continue
		}
		count := 1
		if character > 0xffff {
			count = 2
		}
		if units+count > files.MaxAttachmentNameCharacters {
			break
		}
		output.WriteRune(character)
		units += count
	}
	if output.Len() == 0 || output.String() == "." {
		return "file"
	}
	return output.String()
}

func (value *source) archive(ctx context.Context, target *destination, directory string) (map[string]contracts.Attachment, []archivedFile, []string, error) {
	var attachments *destination
	if len(value.files) > 0 {
		if err := target.root.Mkdir("attachments", 0700); err != nil {
			return nil, nil, nil, ErrUnconfirmed
		}
		if err := syncDirectory(target.root); err != nil {
			return nil, nil, nil, ErrUnconfirmed
		}
		var err error
		attachments, err = openDestination(filepath.Join(directory, "attachments"))
		if err != nil || !target.managed.Unchanged() {
			if attachments != nil {
				attachments.close()
			}
			return nil, nil, nil, ErrChanged
		}
		defer attachments.close()
	}
	return value.archiveFiles(ctx, attachments, directory)
}

func (value *source) archiveFiles(ctx context.Context, attachments *destination, directory string) (map[string]contracts.Attachment, []archivedFile, []string, error) {
	mapped := map[string]contracts.Attachment{}
	archived := []archivedFile{}
	warnings := []string{}
	for _, item := range value.files {
		if item.Unavailable {
			warnings = append(warnings, "attachment_missing")
			continue
		}
		data, err := value.root.ReadFile(ctx, filepath.Join("files", item.ID), maxFileBytes)
		if err != nil || int64(len(data)) != item.Bytes || hash(data) != item.SHA256 {
			return nil, nil, nil, ErrChanged
		}
		name := safeName(item.Name)
		mediaType, err := files.InspectContent(data, name)
		if err != nil {
			// An export archives bytes. A misleading extension cannot turn a
			// binary file into a requirement to parse user content as JSON.
			mediaType, err = files.InspectContent(data, "file")
		}
		if err != nil {
			return nil, nil, nil, ErrCapacity
		}
		id, err := uuid.NewRandom()
		if err != nil {
			return nil, nil, nil, ErrUnconfirmed
		}
		entry := contracts.Attachment{
			ID: id.String(), Name: name, Type: mediaType,
			Size: contracts.Some(float64(item.Bytes)), Hash: item.SHA256,
			GuestPath: filepath.Join(directory, "attachments", id.String()+".bin"),
		}
		encoded, err := json.Marshal(entry)
		if err != nil || len(encoded) > files.MaxAttachmentMetadataBytes {
			return nil, nil, nil, ErrCapacity
		}
		if err := attachments.exclusive(ctx, id.String()+".bin", data); err != nil {
			return nil, nil, nil, err
		}
		if err := attachments.exclusive(ctx, id.String()+".json", encoded); err != nil {
			return nil, nil, nil, err
		}
		mapped[item.ID] = entry
		archived = append(archived, archivedFile{
			LegacyID: item.ID, ID: entry.ID, Bytes: item.Bytes, SHA256: item.SHA256, MetadataSHA256: hash(encoded),
		})
	}
	return mapped, archived, warnings, nil
}
