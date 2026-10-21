package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"io/fs"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func (library *Library) ExportZIP(ctx context.Context, name string) ([]byte, error) {
	snapshot, err := library.ExportSnapshot(ctx, name)
	if err != nil {
		return nil, err
	}
	if nonText.MatchString(snapshot.Description) || nonText.MatchString(snapshot.Instructions) {
		return nil, invalid()
	}
	output := map[string][]byte{"SKILL.md": manifestBytes(snapshot.Name, snapshot.Description, snapshot.Instructions)}
	for name, value := range snapshot.Files {
		output[name] = []byte(value)
	}
	for name, value := range snapshot.BinaryFiles {
		data, err := decodeBinary(value)
		if err != nil {
			return nil, err
		}
		output[name] = data
	}
	for _, value := range []string{snapshot.Name, snapshot.Description, snapshot.Instructions} {
		if library.secret(ctx, []byte(value)) {
			return nil, credentials()
		}
	}
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	names := sortedNames(output)
	names = slices.DeleteFunc(names, func(value string) bool { return value == "SKILL.md" })
	names = append([]string{"SKILL.md"}, names...)
	for _, relative := range names {
		if err := ctx.Err(); err != nil {
			_ = writer.Close()
			return nil, err
		}
		header := &zip.FileHeader{Name: name + "/" + relative, Method: zip.Store}
		header.SetMode(0o600)
		header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
		entry, err := writer.CreateHeader(header)
		if err != nil {
			_ = writer.Close()
			return nil, invalid()
		}
		if _, err := entry.Write(output[relative]); err != nil {
			_ = writer.Close()
			return nil, invalid()
		}
	}
	if err := writer.Close(); err != nil {
		return nil, invalid()
	}
	if buffer.Len() > ArchiveBytes {
		return nil, limited()
	}
	return buffer.Bytes(), nil
}

func safeArchivePath(name string) bool {
	if name == "" || contracts.UTF16Length(name) > 512 || hasControl(name) || strings.ContainsRune(name, '\\') {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsRune(part, ':') {
			return false
		}
	}
	return true
}

func selectFiles[T any](input map[string]T) (map[string]T, error) {
	candidates := []string{}
	for name := range input {
		if path.Base(name) == "SKILL.md" {
			candidates = append(candidates, name)
		}
	}
	if len(candidates) != 1 {
		return nil, invalid()
	}
	prefix := strings.TrimSuffix(candidates[0], "SKILL.md")
	selected := map[string]T{}
	for name, value := range input {
		if strings.HasPrefix(name, prefix) {
			relative := strings.TrimPrefix(name, prefix)
			if relative != "SKILL.md" && !ValidFileName(relative) {
				return nil, invalid()
			}
			selected[relative] = value
		}
	}
	if len(selected) > SupportFileLimit+1 {
		return nil, limited()
	}
	output := map[string][]byte{}
	for name := range selected {
		if name != "SKILL.md" {
			output[name] = nil
		}
	}
	if err := validatePaths(output); err != nil {
		return nil, err
	}
	return selected, nil
}

func readZIP(ctx context.Context, data []byte) (map[string][]byte, error) {
	if len(data) > ArchiveBytes {
		return nil, limited()
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, invalid()
	}
	if len(reader.File) > TreeEntryLimit {
		return nil, limited()
	}
	seen := map[string]bool{}
	entries := map[string]*zip.File{}
	var total uint64
	for _, entry := range reader.File {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		directory := strings.HasSuffix(entry.Name, "/")
		name := strings.TrimSuffix(entry.Name, "/")
		if !safeArchivePath(name) || seen[strings.ToLower(name)] {
			return nil, invalid()
		}
		seen[strings.ToLower(name)] = true
		mode := entry.Mode()
		if entry.Flags&1 != 0 || mode&fs.ModeSymlink != 0 || (directory && !mode.IsDir()) || (!directory && !mode.IsRegular()) {
			return nil, invalid()
		}
		if entry.UncompressedSize64 > FileBytes || entry.CompressedSize64 > ArchiveBytes || directory && entry.UncompressedSize64 != 0 {
			return nil, limited()
		}
		total += entry.UncompressedSize64
		if total > TotalBytes+FileBytes {
			return nil, limited()
		}
		if !directory {
			entries[name] = entry
		}
	}
	selected, err := selectFiles(entries)
	if err != nil {
		return nil, err
	}
	result := map[string][]byte{}
	for _, name := range sortedNames(selected) {
		entry := selected[name]
		file, err := entry.Open()
		if err != nil {
			return nil, invalid()
		}
		value, readErr := io.ReadAll(io.LimitReader(guardedReader{ctx: ctx, reader: file}, FileBytes+1))
		closeErr := file.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// archive/zip verifies the CRC when EOF is reached.
		if readErr != nil || closeErr != nil || uint64(len(value)) != entry.UncompressedSize64 || len(value) > FileBytes {
			return nil, invalid()
		}
		result[name] = value
	}
	return result, nil
}

type guardedReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader guardedReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(buffer)
}
