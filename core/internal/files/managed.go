package files

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

var (
	ErrManagedPath = errors.New("managed_path_invalid")
	ErrFileChanged = errors.New("managed_file_changed")
	ErrFileLimit   = errors.New("managed_file_limit")
)

// OrdinaryDirectory never traverses symbolic links or junctions while creating
// the destination. Each missing component is created and checked separately.
func OrdinaryDirectory(directory string, create bool) (string, error) {
	if !filepath.IsAbs(directory) || strings.ContainsRune(directory, 0) {
		return "", ErrManagedPath
	}
	absolute := filepath.Clean(directory)
	volume := filepath.VolumeName(absolute)
	current := volume + string(filepath.Separator)
	relative, err := filepath.Rel(current, absolute)
	if err != nil {
		return "", ErrManagedPath
	}
	parts := []string{""}
	if relative != "." {
		parts = append(parts, strings.Split(relative, string(filepath.Separator))...)
	}
	for _, part := range parts {
		if part != "" {
			current = filepath.Join(current, part)
		}
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) && create {
			if err = os.Mkdir(current, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
				return "", err
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
			return "", ErrManagedPath
		}
	}
	return absolute, nil
}

func sameFile(left, right fs.FileInfo) bool {
	return os.SameFile(left, right) && left.Size() == right.Size() && left.ModTime().Equal(right.ModTime())
}

// ReadRegular holds an opened ordinary, singly linked file, bounds allocation
// and verifies that neither the file nor its path changed during the read.
func ReadRegular(name string, maxBytes int64) ([]byte, error) {
	if maxBytes < 0 || !filepath.IsAbs(name) {
		return nil, ErrManagedPath
	}
	if _, err := OrdinaryDirectory(filepath.Dir(name), false); err != nil {
		return nil, err
	}
	before, err := os.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > maxBytes {
		return nil, ErrFileLimit
	}
	file, err := openRegular(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameFile(before, opened) {
		return nil, ErrFileChanged
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrFileLimit
	}
	after, err := file.Stat()
	pathAfter, pathErr := os.Lstat(name)
	if err != nil || pathErr != nil || !sameFile(opened, after) || !sameFile(opened, pathAfter) || int64(len(data)) != opened.Size() {
		return nil, ErrFileChanged
	}
	return data, nil
}

func optionalIdentity(name string) (fs.FileInfo, error) {
	info, err := os.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !singleLink(name, info) {
		return nil, ErrFileChanged
	}
	return info, nil
}

func unchanged(name string, expected fs.FileInfo) bool {
	current, err := os.Lstat(name)
	if expected == nil {
		return errors.Is(err, fs.ErrNotExist)
	}
	return err == nil && sameFile(expected, current) && singleLink(name, current)
}

func RenameManaged(ctx context.Context, source, destination string) error {
	return renameManaged(ctx, source, destination, nil, os.Rename, renameWait)
}

// RenameManagedFile retains the caller's opened file snapshot through publication.
// A reused source path must not become the new publication's ownership baseline.
func RenameManagedFile(ctx context.Context, source, destination string, identity fs.FileInfo) error {
	if identity == nil || !identity.Mode().IsRegular() {
		return ErrManagedPath
	}
	return renameManaged(ctx, source, destination, identity, os.Rename, renameWait)
}

func renameManaged(
	ctx context.Context,
	source, destination string,
	identity fs.FileInfo,
	rename func(string, string) error,
	wait func(context.Context, int) error,
) error {
	if !filepath.IsAbs(source) || !filepath.IsAbs(destination) {
		return ErrManagedPath
	}
	parents := make(map[string]fs.FileInfo)
	for _, parent := range []string{filepath.Dir(source), filepath.Dir(destination)} {
		if _, err := OrdinaryDirectory(parent, false); err != nil {
			return err
		}
		info, err := CaptureIdentity(parent)
		if err != nil {
			return err
		}
		parents[parent] = info
	}
	before, err := CaptureIdentity(source)
	if err != nil {
		return err
	}
	if before.Mode()&fs.ModeSymlink != 0 {
		return ErrManagedPath
	}
	if identity != nil && (!sameFile(identity, before) || !singleLink(source, before)) {
		return ErrFileChanged
	}
	if _, err = os.Lstat(destination); !errors.Is(err, fs.ErrNotExist) {
		return ErrFileChanged
	}
	for attempt := 0; attempt < RenameAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		for parent, expected := range parents {
			if _, err := OrdinaryDirectory(parent, false); err != nil {
				return ErrFileChanged
			}
			info, err := os.Lstat(parent)
			if err != nil || !os.SameFile(expected, info) {
				return ErrFileChanged
			}
		}
		current, readErr := os.Lstat(source)
		if readErr != nil || !os.SameFile(before, current) ||
			identity != nil && (!sameFile(identity, current) || !singleLink(source, current)) {
			return ErrFileChanged
		}
		if _, destinationErr := os.Lstat(destination); !errors.Is(destinationErr, fs.ErrNotExist) {
			return ErrFileChanged
		}
		if err = rename(source, destination); err == nil {
			return nil
		}
		if runtime.GOOS != "windows" || !retryableRename(err) || attempt+1 == RenameAttempts {
			return err
		}
		if err = wait(ctx, attempt); err != nil {
			return err
		}
	}
	return err
}
