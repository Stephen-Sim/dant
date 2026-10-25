package runtime

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	platformruntime "runtime"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	conversationNPMManifestBytes = 64 * 1024
	conversationNativeBytes      = 512 * 1024 * 1024
	conversationNPMPackage       = "@openai/codex"
	conversationNPMPlatform      = "linux-x64"
	conversationNPMNative        = "@openai/codex-linux-x64"
	conversationNPMTarget        = "x86_64-unknown-linux-musl"
)

// A selected per-user npm launcher cannot run inside the namespace: its sibling
// modules are deliberately hidden. Resolve only that installation's pinned
// optional native package, then expose its single executable instead of a home
// or node_modules directory. Unsupported layouts do not select another CLI.
func conversationNPMCommand(command string) (string, error) {
	if platformruntime.GOARCH != "amd64" || filepath.Base(command) != "codex.js" || filepath.Base(filepath.Dir(command)) != "bin" {
		return "", ErrWorkerRole
	}
	root := filepath.Dir(filepath.Dir(command))
	if filepath.Base(root) != "codex" || filepath.Base(filepath.Dir(root)) != "@openai" || filepath.Base(filepath.Dir(filepath.Dir(root))) != "node_modules" {
		return "", ErrWorkerRole
	}
	launcher, err := openConversationCommandFile(command, conversationNPMManifestBytes)
	if err != nil {
		return "", err
	}
	defer launcher.file.Close()
	launcherBytes, err := io.ReadAll(io.LimitReader(launcher.file, conversationNPMManifestBytes+1))
	if err != nil || !bytes.HasPrefix(launcherBytes, []byte("#!/usr/bin/env node\n")) {
		return "", ErrWorkerRole
	}

	manifest, err := openConversationCommandFile(filepath.Join(root, "package.json"), conversationNPMManifestBytes)
	if err != nil {
		return "", err
	}
	defer manifest.file.Close()
	metadata, err := manifest.object()
	if err != nil || observerString(metadata, "name") != conversationNPMPackage || observerString(metadata, "version") != conversationCodexVersion {
		return "", ErrWorkerRole
	}
	bin, binErr := contracts.DecodeObject(metadata["bin"], conversationNPMManifestBytes)
	dependencies, dependencyErr := contracts.DecodeObject(metadata["optionalDependencies"], conversationNPMManifestBytes)
	version := conversationCodexVersion + "-" + conversationNPMPlatform
	if binErr != nil || observerString(bin, "codex") != "bin/codex.js" || dependencyErr != nil || observerString(dependencies, conversationNPMNative) != "npm:"+conversationNPMPackage+"@"+version {
		return "", ErrWorkerRole
	}

	nativeRoot := filepath.Join(root, "node_modules", "@openai", "codex-linux-x64")
	nativeManifest, err := openConversationCommandFile(filepath.Join(nativeRoot, "package.json"), conversationNPMManifestBytes)
	if err != nil {
		return "", err
	}
	defer nativeManifest.file.Close()
	nativeMetadata, err := nativeManifest.object()
	nativeBin, hasNativeBin := nativeMetadata["bin"]
	if err != nil || observerString(nativeMetadata, "name") != conversationNPMPackage || observerString(nativeMetadata, "version") != version || hasNativeBin && strings.TrimSpace(string(nativeBin)) != "null" {
		return "", ErrWorkerRole
	}

	path := filepath.Join(nativeRoot, "vendor", conversationNPMTarget, "bin", "codex")
	native, err := openConversationCommandFile(path, conversationNativeBytes)
	if err != nil {
		return "", err
	}
	defer native.file.Close()
	var header [24]byte
	if _, err := io.ReadFull(native.file, header[:]); err != nil || !bytes.Equal(header[:7], []byte("\x7fELF\x02\x01\x01")) || binary.LittleEndian.Uint16(header[18:20]) != 62 || binary.LittleEndian.Uint32(header[20:24]) != 1 {
		return "", ErrWorkerRole
	}
	typeID := binary.LittleEndian.Uint16(header[16:18])
	if typeID != 2 && typeID != 3 || platformruntime.GOOS != "windows" && native.identity.Mode().Perm()&0o111 == 0 {
		return "", ErrWorkerRole
	}
	for _, captured := range []*conversationCommandFile{launcher, manifest, nativeManifest, native} {
		if !captured.current() {
			return "", ErrWorkerRole
		}
	}
	return path, nil
}

type conversationCommandFile struct {
	path     string
	file     *os.File
	identity os.FileInfo
}

func openConversationCommandFile(path string, limit int64) (*conversationCommandFile, error) {
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil || !filepath.IsAbs(path) || canonical != path {
		return nil, ErrWorkerRole
	}
	entry, err := os.Lstat(path)
	if err != nil || !entry.Mode().IsRegular() || entry.Size() < 1 || entry.Size() > limit {
		return nil, ErrWorkerRole
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrWorkerRole
	}
	identity, err := file.Stat()
	if err != nil || !identity.Mode().IsRegular() || identity.Size() != entry.Size() || !identity.ModTime().Equal(entry.ModTime()) {
		file.Close()
		return nil, ErrWorkerRole
	}
	captured := &conversationCommandFile{path: path, file: file, identity: identity}
	if !captured.current() {
		file.Close()
		return nil, ErrWorkerRole
	}
	return captured, nil
}

func (captured *conversationCommandFile) current() bool {
	canonical, err := filepath.EvalSymlinks(captured.path)
	if err != nil || canonical != captured.path {
		return false
	}
	entry, err := os.Lstat(captured.path)
	if err != nil || !entry.Mode().IsRegular() {
		return false
	}
	file, err := os.Open(captured.path)
	if err != nil {
		return false
	}
	defer file.Close()
	current, err := file.Stat()
	held, heldErr := captured.file.Stat()
	return err == nil && heldErr == nil && current.Mode().IsRegular() && os.SameFile(captured.identity, current) && os.SameFile(captured.identity, held) && current.Size() == captured.identity.Size() && held.Size() == captured.identity.Size() && current.ModTime().Equal(captured.identity.ModTime()) && held.ModTime().Equal(captured.identity.ModTime()) && current.Mode() == captured.identity.Mode()
}

func (captured *conversationCommandFile) object() (contracts.RawObject, error) {
	raw, err := io.ReadAll(io.LimitReader(captured.file, conversationNPMManifestBytes+1))
	if err != nil || !captured.current() || !contracts.ValidUnicodeJSON(raw) {
		return nil, ErrWorkerRole
	}
	object, err := contracts.DecodeObject(raw, conversationNPMManifestBytes)
	if err != nil {
		return nil, ErrWorkerRole
	}
	return object, nil
}
