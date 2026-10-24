package runtime

import (
	"os"
	"path/filepath"
)

// conversationDirectory retains the identity from an opened, newly created
// directory. Windows path-only FileInfo may defer its file-ID lookup until a
// later SameFile call, after that path has already been replaced.
type conversationDirectory struct {
	path     string
	identity os.FileInfo
}

func captureConversationDirectory(path string) (os.FileInfo, error) {
	entry, err := os.Lstat(path)
	if err != nil || entry.Mode()&os.ModeType != os.ModeDir {
		return nil, ErrWorkerRole
	}
	handle, err := os.Open(path)
	if err != nil {
		return nil, ErrWorkerRole
	}
	identity, statErr := handle.Stat()
	closeErr := handle.Close()
	if statErr != nil || closeErr != nil || !identity.IsDir() {
		return nil, ErrWorkerRole
	}
	current, err := os.Lstat(path)
	if err != nil || current.Mode()&os.ModeType != os.ModeDir {
		return nil, ErrWorkerRole
	}
	return identity, nil
}

func canonicalConversationDirectory(path string, identity os.FileInfo) (*conversationDirectory, error) {
	if identity == nil {
		return nil, ErrWorkerRole
	}
	original, err := captureConversationDirectory(path)
	if err != nil || !os.SameFile(identity, original) {
		return nil, ErrWorkerRole
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil || !filepath.IsAbs(canonical) || filepath.Clean(canonical) != canonical {
		return nil, ErrWorkerRole
	}
	current, err := captureConversationDirectory(canonical)
	if err != nil || !os.SameFile(identity, current) {
		return nil, ErrWorkerRole
	}
	original, err = captureConversationDirectory(path)
	if err != nil || !os.SameFile(identity, original) {
		return nil, ErrWorkerRole
	}
	return &conversationDirectory{path: canonical, identity: identity}, nil
}

func (directory *conversationDirectory) current() bool {
	if directory == nil || directory.identity == nil {
		return false
	}
	current, err := captureConversationDirectory(directory.path)
	return err == nil && os.SameFile(directory.identity, current)
}

func (directory *conversationDirectory) remove() bool {
	if !directory.current() {
		return false
	}
	return os.RemoveAll(directory.path) == nil
}

func createConversationDirectory() (*conversationDirectory, error) {
	created, err := os.MkdirTemp("", "dant-conversation-")
	if err != nil {
		return nil, ErrDisconnected
	}
	identity, err := captureConversationDirectory(created)
	if err != nil {
		// Without retained identity even cleanup is unconfirmed. Preserve the
		// path rather than adopting or deleting a possible replacement.
		return nil, err
	}
	directory, err := canonicalConversationDirectory(created, identity)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"home", "config", "work", "managed"} {
		if !directory.current() {
			return nil, ErrWorkerRole
		}
		if err = os.Mkdir(filepath.Join(directory.path, name), 0o700); err != nil {
			directory.remove()
			return nil, ErrDisconnected
		}
	}
	if !directory.current() {
		return nil, ErrWorkerRole
	}
	if err = os.WriteFile(filepath.Join(directory.path, "managed", "requirements.toml"), []byte(conversationManagedRequirements), 0o600); err != nil {
		directory.remove()
		return nil, ErrDisconnected
	}
	return directory, nil
}
