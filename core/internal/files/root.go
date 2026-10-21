package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type directoryGuard struct {
	parent *os.Root
	name   string
	info   fs.FileInfo
}

// SingleLink validates the already opened regular file handle. Callers retain
// that handle and separately fence the directory and path identities.
func SingleLink(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && info.Mode().IsRegular() && openedSingleLink(file, info)
}

// OpenLockFile returns an anchored ordinary file for an OS kernel lock. The
// caller must keep this ManagedRoot open until the lock handle is closed.
func (managed *ManagedRoot) OpenLockFile(name string) (*os.File, error) {
	if filepath.Base(name) != name {
		return nil, ErrManagedPath
	}
	if _, err := relativeParts(name); err != nil {
		return nil, err
	}
	file, err := managed.root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		if !SingleLink(file) || !managed.Unchanged() {
			_ = file.Close()
			return nil, ErrFileChanged
		}
		return file, nil
	}
	if !os.IsExist(err) {
		return nil, err
	}

	before, err := managed.root.Lstat(name)
	if err != nil || !before.Mode().IsRegular() {
		return nil, ErrManagedPath
	}
	file, err = managed.root.OpenFile(name, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil || !sameFile(before, opened) || !SingleLink(file) || !managed.Unchanged() {
		_ = file.Close()
		return nil, ErrFileChanged
	}
	return file, nil
}

// ManagedRoot owns directory capabilities, rather than resolving an unchecked
// absolute path again after validation. Go's Root anchors operations across
// directory renames on the supported Windows, Linux and macOS platforms.
type ManagedRoot struct {
	name   string
	root   *os.Root
	owned  []*os.Root
	guards []directoryGuard
}

func checkedChild(parent *os.Root, name string, create bool) (*os.Root, directoryGuard, error) {
	before, err := parent.Lstat(name)
	if os.IsNotExist(err) && create {
		if err := parent.Mkdir(name, 0o700); err != nil && !os.IsExist(err) {
			return nil, directoryGuard{}, err
		}
		before, err = parent.Lstat(name)
	}
	if err != nil {
		return nil, directoryGuard{}, err
	}
	if !before.IsDir() || before.Mode()&fs.ModeSymlink != 0 {
		return nil, directoryGuard{}, ErrManagedPath
	}
	child, err := parent.OpenRoot(name)
	if err != nil {
		return nil, directoryGuard{}, err
	}
	opened, err := child.Stat(".")
	if err != nil || !os.SameFile(before, opened) {
		child.Close()
		return nil, directoryGuard{}, ErrFileChanged
	}
	return child, directoryGuard{parent: parent, name: name, info: opened}, nil
}

func OpenManagedRoot(directory string, create bool) (*ManagedRoot, error) {
	if !filepath.IsAbs(directory) || strings.ContainsRune(directory, 0) {
		return nil, ErrManagedPath
	}
	directory = filepath.Clean(directory)
	volume := filepath.VolumeName(directory) + string(filepath.Separator)
	root, err := os.OpenRoot(volume)
	if err != nil {
		return nil, err
	}
	managed := &ManagedRoot{name: directory, root: root, owned: []*os.Root{root}}
	failed := true
	defer func() {
		if failed {
			managed.Close()
		}
	}()
	relative, err := filepath.Rel(volume, directory)
	if err != nil {
		return nil, ErrManagedPath
	}
	if relative != "." {
		for _, part := range strings.Split(relative, string(filepath.Separator)) {
			child, guard, err := checkedChild(managed.root, part, create)
			if err != nil {
				return nil, err
			}
			managed.owned = append(managed.owned, child)
			managed.guards = append(managed.guards, guard)
			managed.root = child
		}
	}
	if !managed.Unchanged() {
		return nil, ErrFileChanged
	}
	failed = false
	return managed, nil
}

func (managed *ManagedRoot) Close() error {
	var failure error
	for index := len(managed.owned) - 1; index >= 0; index-- {
		if err := managed.owned[index].Close(); err != nil && failure == nil {
			failure = err
		}
	}
	return failure
}

func guardsUnchanged(guards []directoryGuard) bool {
	for _, guard := range guards {
		current, err := guard.parent.Lstat(guard.name)
		if err != nil || !current.IsDir() || current.Mode()&fs.ModeSymlink != 0 || !os.SameFile(guard.info, current) {
			return false
		}
	}
	return true
}

func (managed *ManagedRoot) Unchanged() bool { return guardsUnchanged(managed.guards) }

func relativeParts(name string) ([]string, error) {
	if !fs.ValidPath(filepath.ToSlash(name)) || name == "." || filepath.IsAbs(name) {
		return nil, ErrManagedPath
	}
	return strings.Split(name, string(filepath.Separator)), nil
}

func (managed *ManagedRoot) openParents(parts []string) (*os.Root, []*os.Root, []directoryGuard, error) {
	root := managed.root
	owned := make([]*os.Root, 0, len(parts))
	guards := make([]directoryGuard, 0, len(parts))
	for _, part := range parts {
		child, guard, err := checkedChild(root, part, false)
		if err != nil {
			for _, root := range owned {
				root.Close()
			}
			return nil, nil, nil, err
		}
		owned = append(owned, child)
		guards = append(guards, guard)
		root = child
	}
	return root, owned, guards, nil
}

func closeRoots(roots []*os.Root) {
	for index := len(roots) - 1; index >= 0; index-- {
		_ = roots[index].Close()
	}
}

type guardedRead struct {
	context context.Context
	reader  io.Reader
}

func (reader guardedRead) Read(buffer []byte) (int, error) {
	if err := reader.context.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(buffer)
}

// read feeds a verified file into a bounded consumer while every directory
// capability remains open. It never follows a symlink or a hard-linked file.
func (managed *ManagedRoot) read(ctx context.Context, name string, max int64, consume func(io.Reader) error) (fs.FileInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	parts, err := relativeParts(name)
	if err != nil {
		return nil, err
	}
	root, owned, guards, err := managed.openParents(parts[:len(parts)-1])
	if err != nil {
		return nil, err
	}
	defer closeRoots(owned)
	leaf := parts[len(parts)-1]
	before, err := root.Lstat(leaf)
	if err != nil {
		return nil, err
	}
	if max < 0 || !before.Mode().IsRegular() || before.Size() > max {
		return nil, ErrFileLimit
	}
	file, err := root.Open(leaf)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameFile(before, opened) || !openedSingleLink(file, opened) {
		return nil, ErrFileChanged
	}
	limited := &io.LimitedReader{R: guardedRead{context: ctx, reader: file}, N: max + 1}
	if err := consume(limited); err != nil {
		return nil, err
	}
	if max+1-limited.N > max {
		return nil, ErrFileLimit
	}
	after, afterErr := file.Stat()
	current, pathErr := root.Lstat(leaf)
	if afterErr != nil || pathErr != nil || !sameFile(opened, after) ||
		!sameFile(opened, current) || !openedSingleLink(file, after) ||
		!managed.Unchanged() || !guardsUnchanged(guards) {
		return nil, ErrFileChanged
	}
	if max+1-limited.N != opened.Size() {
		return nil, ErrFileChanged
	}
	return opened, nil
}

func (managed *ManagedRoot) ReadFile(ctx context.Context, name string, max int64) ([]byte, error) {
	data, _, err := managed.ReadFileInfo(ctx, name, max)
	return data, err
}

// ReadFileInfo returns bytes and their already verified, opened file identity.
// A consumer retaining that identity must not stat the path again as its baseline.
func (managed *ManagedRoot) ReadFileInfo(ctx context.Context, name string, max int64) ([]byte, fs.FileInfo, error) {
	var data []byte
	info, err := managed.read(ctx, name, max, func(reader io.Reader) error {
		var err error
		data, err = io.ReadAll(reader)
		return err
	})
	return data, info, err
}

func (managed *ManagedRoot) Digest(ctx context.Context, name string, max int64) (string, int64, error) {
	hash := sha256.New()
	info, err := managed.read(ctx, name, max, func(reader io.Reader) error {
		_, err := io.Copy(hash, reader)
		return err
	})
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hash.Sum(nil)), info.Size(), nil
}

// WithReader holds the file and ancestor capabilities for a streaming consumer.
// The callback must finish before returning; retaining the reader is invalid.
func (managed *ManagedRoot) WithReader(ctx context.Context, name string, max int64, consume func(io.Reader) error) error {
	if consume == nil {
		return ErrManagedPath
	}
	_, err := managed.read(ctx, name, max, consume)
	return err
}

func (managed *ManagedRoot) ReadDirectory(name string) ([]fs.DirEntry, error) {
	var parts []string
	var err error
	if name != "." {
		parts, err = relativeParts(name)
		if err != nil {
			return nil, err
		}
	}
	root, owned, guards, err := managed.openParents(parts)
	if err != nil {
		return nil, err
	}
	defer closeRoots(owned)
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil, err
	}
	if !managed.Unchanged() || !guardsUnchanged(guards) {
		return nil, ErrFileChanged
	}
	return entries, nil
}

// OrdinaryFile reports whether an anchored leaf is eligible for managed reads.
// Directories, links and hard-linked leaves are never deliverables.
func (managed *ManagedRoot) OrdinaryFile(name string) (bool, error) {
	parts, err := relativeParts(name)
	if err != nil {
		return false, err
	}
	root, owned, guards, err := managed.openParents(parts[:len(parts)-1])
	if err != nil {
		return false, err
	}
	defer closeRoots(owned)
	leaf := parts[len(parts)-1]
	info, err := root.Lstat(leaf)
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, nil
	}
	file, err := root.Open(leaf)
	if err != nil {
		return false, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameFile(info, opened) || !managed.Unchanged() || !guardsUnchanged(guards) {
		return false, ErrFileChanged
	}
	return openedSingleLink(file, opened), nil
}

// AppendFile keeps the opened parent and file identities through the write.
// It is reserved for bounded operational logs; durable state uses WriteAtomic.
func (managed *ManagedRoot) AppendFile(ctx context.Context, name string, data []byte, maximum int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	parts, err := relativeParts(name)
	if err != nil {
		return err
	}
	root, owned, guards, err := managed.openParents(parts[:len(parts)-1])
	if err != nil {
		return err
	}
	defer closeRoots(owned)

	leaf := parts[len(parts)-1]
	before, err := root.Lstat(leaf)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Size()+int64(len(data)) > maximum {
		return ErrFileLimit
	}
	file, err := root.OpenFile(leaf, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return err
	}
	defer file.Close()

	opened, err := file.Stat()
	if err != nil || !sameFile(before, opened) || !openedSingleLink(file, opened) ||
		!managed.Unchanged() || !guardsUnchanged(guards) {
		return ErrFileChanged
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	count, err := file.Write(data)
	if err != nil {
		return err
	}
	if count != len(data) {
		return io.ErrShortWrite
	}

	after, err := file.Stat()
	current, pathErr := root.Lstat(leaf)
	if err != nil || pathErr != nil || after.Size() != opened.Size()+int64(count) ||
		!os.SameFile(opened, after) || !os.SameFile(opened, current) ||
		!openedSingleLink(file, after) || !managed.Unchanged() || !guardsUnchanged(guards) {
		return ErrFileChanged
	}
	return nil
}

// ResetLog deliberately retains the existing inode used by inherited native
// process log handles. It must never be used to persist application state.
func (managed *ManagedRoot) ResetLog(ctx context.Context, name string, data []byte) error {
	if len(data) > 4096 || len(strings.Split(name, string(filepath.Separator))) != 1 {
		return ErrFileLimit
	}
	if _, err := relativeParts(name); err != nil {
		return err
	}
	before, err := managed.root.Lstat(name)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() {
		return ErrManagedPath
	}
	file, err := managed.root.OpenFile(name, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer file.Close()

	opened, err := file.Stat()
	if err != nil || !sameFile(before, opened) || !openedSingleLink(file, opened) || !managed.Unchanged() {
		return ErrFileChanged
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := file.Truncate(0); err != nil {
		return err
	}
	count, err := file.WriteAt(data, 0)
	if err != nil {
		return err
	}
	if count != len(data) {
		return io.ErrShortWrite
	}
	current, err := managed.root.Lstat(name)
	if err != nil || !os.SameFile(opened, current) || !openedSingleLink(file, current) || !managed.Unchanged() {
		return ErrFileChanged
	}
	return nil
}
