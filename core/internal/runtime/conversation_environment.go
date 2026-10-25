package runtime

import (
	"bytes"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	platformruntime "runtime"
	"strings"
)

const conversationManagedRequirements = "[mcp_servers]\n"

// conversationProcessOptions exposes a fresh conversation namespace rather than
// the service home, work computer, credentials, display or existing Codex config.
// The caller alone may append its explicit short-lived provider authentication
// environment. No inherited environment is consulted here.
func conversationProcessOptions(privateRoot, codexCommand string, codexArgs []string) (ProcessOptions, error) {
	root, err := filepath.EvalSymlinks(privateRoot)
	if err != nil || !filepath.IsAbs(privateRoot) || filepath.Clean(privateRoot) != privateRoot || root != privateRoot {
		return ProcessOptions{}, ErrWorkerRole
	}
	if err := validateConversationRoot(root); err != nil {
		return ProcessOptions{}, err
	}

	command, err := filepath.EvalSymlinks(codexCommand)
	if err != nil || !filepath.IsAbs(command) || strings.ContainsRune(command, 0) {
		return ProcessOptions{}, ErrWorkerRole
	}
	info, err := os.Lstat(command)
	if err != nil || !info.Mode().IsRegular() {
		return ProcessOptions{}, ErrWorkerRole
	}
	for _, argument := range codexArgs {
		if strings.ContainsRune(argument, 0) {
			return ProcessOptions{}, ErrWorkerRole
		}
	}

	args := []string{"--die-with-parent", "--new-session", "--unshare-all", "--share-net", "--cap-drop", "ALL"}
	for _, directory := range []string{"/usr", "/bin", "/lib"} {
		args = append(args, "--ro-bind", directory, directory)
	}
	if info, err := os.Stat("/lib64"); err == nil && info.IsDir() {
		args = append(args, "--ro-bind", "/lib64", "/lib64")
	}
	args = append(args, "--dir", "/etc", "--dir", "/etc/codex")
	for _, path := range []string{"/etc/ssl", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group"} {
		args = append(args, "--ro-bind", path, path)
	}
	args = append(args, "--ro-bind", filepath.Join(root, "managed", "requirements.toml"), "/etc/codex/requirements.toml", "--dir", "/conversation")
	for _, directory := range []string{"home", "config", "work"} {
		args = append(args, "--bind", filepath.Join(root, directory), "/conversation/"+directory)
	}
	args = append(args, "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp")

	// The pinned npm launcher resolves its vendor modules relative to /usr. Keep
	// that absolute path. A native executable elsewhere needs only its own file;
	// an external script launcher cannot authorize exposing its sibling directory.
	command, mounts, err := conversationCommandMapping(command)
	if err != nil {
		return ProcessOptions{}, err
	}
	args = append(args, mounts...)
	// Protect policy parents against rename/replacement without remounting the
	// separate writable conversation and temporary mounts read-only.
	args = append(args, "--remount-ro", "/", "--chdir", "/conversation/work", "--", command)
	args = append(args, codexArgs...)

	return ProcessOptions{
		Command:   "/usr/bin/bwrap",
		Args:      args,
		Directory: root,
		Environment: []string{
			"HOME=/conversation/home", "CODEX_HOME=/conversation/config", "PWD=/conversation/work",
			"PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "TMPDIR=/tmp", "TERM=dumb",
		},
	}, nil
}

func conversationCommandMapping(command string) (string, []string, error) {
	if strings.HasPrefix(filepath.ToSlash(command), "/usr/") {
		return command, nil, nil
	}
	file, err := os.Open(command)
	if err != nil {
		return "", nil, ErrWorkerRole
	}
	var prefix [2]byte
	_, readErr := io.ReadFull(file, prefix[:])
	closeErr := file.Close()
	if (readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF) || closeErr != nil {
		return "", nil, ErrWorkerRole
	}
	if bytes.Equal(prefix[:], []byte("#!")) {
		command, err = conversationNPMCommand(command)
		if err != nil {
			return "", nil, err
		}
	}
	return "/tool/codex", []string{"--dir", "/tool", "--ro-bind", command, "/tool/codex"}, nil
}

func validateConversationRoot(root string) error {
	allowed := map[string]bool{".": true, "home": true, "config": true, "work": true, "managed": true, filepath.Join("managed", "requirements.toml"): false}
	seen := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return ErrWorkerRole
		}
		relative, err := filepath.Rel(root, path)
		directory, known := allowed[relative]
		if err != nil || !known || entry.Type()&os.ModeSymlink != 0 {
			return ErrWorkerRole
		}
		info, err := entry.Info()
		if err != nil || info.IsDir() != directory || (!directory && (!info.Mode().IsRegular() || info.Size() != int64(len(conversationManagedRequirements)))) {
			return ErrWorkerRole
		}
		permissions := os.FileMode(0o600)
		if directory {
			permissions = 0o700
		}
		// Windows fixtures exercise the pure launch plan without Linux mounts.
		// Real conversation executors are admitted only on the verified Linux VM.
		if platformruntime.GOOS != "windows" && info.Mode().Perm() != permissions {
			return ErrWorkerRole
		}
		seen++
		return nil
	})
	if err != nil || seen != len(allowed) {
		return ErrWorkerRole
	}
	file, err := os.Open(filepath.Join(root, "managed", "requirements.toml"))
	if err != nil {
		return ErrWorkerRole
	}
	raw, readErr := io.ReadAll(io.LimitReader(file, int64(len(conversationManagedRequirements))+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || string(raw) != conversationManagedRequirements {
		return ErrWorkerRole
	}
	return nil
}
