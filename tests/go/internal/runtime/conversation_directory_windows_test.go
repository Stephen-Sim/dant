package runtime

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func windowsConversationTempAlias(t *testing.T) (string, string) {
	t.Helper()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	parent = filepath.Join(parent, "synthetic conversation namespace temporary directory")
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	input, err := syscall.UTF16PtrFromString(parent)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]uint16, 32768)
	length, shortErr := syscall.GetShortPathName(input, &buffer[0], uint32(len(buffer)))
	if shortErr == nil && length > 0 && int(length) < len(buffer) {
		alias := syscall.UTF16ToString(buffer[:length])
		if alias != parent {
			t.Log("using an OS-reported short-path temporary alias")
			return alias, parent
		}
	}
	// Some volumes disable 8.3 names. Exercise the OS-supported extended path
	// namespace instead; this is the same real temporary directory, not a link.
	t.Log("using an extended-path alias on a volume without a distinct short name")
	if strings.HasPrefix(parent, `\\`) {
		return `\\?\UNC\` + strings.TrimPrefix(parent, `\\`), parent
	}
	return `\\?\` + parent, parent
}

func TestConversationDirectoryWindowsTemporaryAliasKeepsTheCreatedIdentity(t *testing.T) {
	alias, parent := windowsConversationTempAlias(t)
	for _, key := range []string{"TMP", "TEMP"} {
		t.Setenv(key, alias)
	}
	directory, err := createConversationDirectory()
	if err != nil {
		t.Fatal("OS-derived temporary alias prevented private namespace preparation", err)
	}
	t.Cleanup(func() { directory.remove() })
	parentInfo, err := captureConversationDirectory(parent)
	if err != nil {
		t.Fatal(err)
	}
	actualParent, err := captureConversationDirectory(filepath.Dir(directory.path))
	if err != nil || !os.SameFile(parentInfo, actualParent) || !directory.current() {
		t.Fatal("canonicalization switched the created directory or its parent")
	}
	if resolved, err := filepath.EvalSymlinks(directory.path); err != nil || resolved != directory.path {
		t.Fatal("fresh root retained the temporary alias instead of canonical spelling")
	}
	command := filepath.Join(parent, "synthetic-command")
	if err := os.WriteFile(command, []byte("synthetic executable never launched"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := conversationProcessOptions(directory.path, command, nil); err != nil {
		t.Fatal("canonical owned directory failed the unchanged namespace policy", err)
	}
}

func TestConversationSessionWindowsTemporaryAliasCompletesSyntheticHandshakeAndCleanup(t *testing.T) {
	alias, _ := windowsConversationTempAlias(t)
	for _, key := range []string{"TMP", "TEMP"} {
		t.Setenv(key, alias)
	}
	fixture := sessionFixture(t)
	session := fixture.start(t)
	if fixture.spawns.Load() != 1 || fixture.process.Directory != session.root || !session.directory.current() {
		t.Fatal("temporary alias lost the private executor's scope")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if stopped, err := session.TerminateConfirmed(ctx); err != nil || !stopped {
		t.Fatal("synthetic executor cleanup was not confirmed", err)
	}
	if _, err := os.Stat(session.root); !os.IsNotExist(err) {
		t.Fatal("confirmed shutdown did not clean its exact owned private directory")
	}
}

func TestConversationDirectoryWindowsReparseReplacementCannotAdoptOrRemoveItsTarget(t *testing.T) {
	parent := privateConversationTemp(t)
	directory, err := createConversationDirectory()
	if err != nil {
		t.Fatal(err)
	}
	held := filepath.Join(parent, "retained-private-root")
	if err := os.Rename(directory.path, held); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(held, directory.path); err != nil {
		// Ordinary directory junctions do not need symbolic-link privileges.
		// Both environment values refer only to this test's isolated parent.
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
			"$ErrorActionPreference = 'Stop'; $null = New-Item -ItemType Junction -Path $env:DANT_NAMESPACE_TEST_LINK -Target $env:DANT_NAMESPACE_TEST_TARGET")
		command.Env = []string{"SystemRoot=" + os.Getenv("SystemRoot"), "DANT_NAMESPACE_TEST_LINK=" + directory.path, "DANT_NAMESPACE_TEST_TARGET=" + held}
		if err := command.Run(); err != nil {
			t.Fatal("isolated reparse fixture could not be created")
		}
	}
	entry, err := os.Lstat(directory.path)
	if err != nil || entry.Mode()&os.ModeSymlink == 0 {
		t.Fatal("fixture did not create an actual reparse point")
	}
	if _, err := captureConversationDirectory(directory.path); !errors.Is(err, ErrWorkerRole) {
		t.Fatal("reparse path was accepted as the created directory")
	}
	if _, err := canonicalConversationDirectory(directory.path, directory.identity); !errors.Is(err, ErrWorkerRole) {
		t.Fatal("canonicalization adopted a reparse replacement pointing to the original")
	}
	if directory.current() || directory.remove() {
		t.Fatal("cleanup followed a reparse replacement")
	}
	if raw, err := os.ReadFile(filepath.Join(held, "managed", "requirements.toml")); err != nil || string(raw) != conversationManagedRequirements {
		t.Fatal("reparse cleanup changed the retained policy or its target")
	}
}
