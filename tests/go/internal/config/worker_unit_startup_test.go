package config

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

func workerAppLink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err == nil {
		return
	} else if runtime.GOOS != "windows" {
		t.Fatal(err)
	}

	// Directory junctions exercise the same rejected reparse boundary without
	// requiring Windows symbolic-link privileges or administrator approval.
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
		"$ErrorActionPreference = 'Stop'; $null = New-Item -ItemType Junction -Path $env:DANT_CONFIG_TEST_LINK -Target $env:DANT_CONFIG_TEST_TARGET")
	command.Env = append(os.Environ(), "DANT_CONFIG_TEST_LINK="+link, "DANT_CONFIG_TEST_TARGET="+target)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("isolated directory junction could not be created: %v: %s", err, output)
	}
}

func TestWorkerUnitStartupSeparatesActivationLinkFromRealConfigurationRoot(t *testing.T) {
	home := filepath.Join(t.TempDir(), "non-default 用户 home")
	root := filepath.Join(home, "dant")
	source := filepath.Join(root, "releases", "source.dynamic-fixture")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(root, "app")
	workerAppLink(t, source, app)
	info, err := os.Lstat(app)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("fixture did not retain a real activation link", err)
	}
	if _, err := os.Lstat(filepath.Join(source, ".env")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("fixture unexpectedly contains project configuration", err)
	}

	data := filepath.Join(root, "data")
	workspaces := filepath.Join(root, "workspaces")
	protocol := DefaultProtocol()
	input := StartupInput{
		Arguments: []string{
			"--role=worker", "--root=" + app,
			"--data-dir=" + data, "--workspace-root=" + workspaces,
		},
		Environment: []string{
			"DANT_DATA=" + data, "DANT_WORKSPACE_ROOT=" + workspaces,
			"DANT_PORT=" + strconv.Itoa(protocol.APIPort),
			"DANT_GUEST_HOST=" + protocol.LoopbackHost,
			"DANT_GUEST_PORT=" + strconv.Itoa(protocol.GuestPort),
		},
		WorkingDirectory: source,
		Home:             home,
		Hostname:         "fixture-vm",
		Username:         "fixture-user",
	}
	if _, err := LoadStartup(input); !errors.Is(err, ErrStartup) {
		t.Fatal("legacy unit accepted a linked default configuration directory", err)
	}
	unsafe := input
	unsafe.Arguments = append(append([]string{}, input.Arguments...), "--config-root="+app)
	if _, err := LoadStartup(unsafe); !errors.Is(err, ErrStartup) {
		t.Fatal("explicit configuration root bypassed the ordinary-directory guard", err)
	}

	input.Arguments = append(input.Arguments, "--config-root="+source)
	startup, err := LoadStartup(input)
	if err != nil {
		t.Fatal("deployed worker could not use its verified real configuration directory", err)
	}
	if startup.Role != RoleWorker || startup.Root != app || startup.Home != home ||
		startup.DataDir != data || startup.WorkspaceRoot != workspaces ||
		startup.Listen != NativeEndpoint() || startup.Network.Guest != endpoint(protocol.LoopbackHost, protocol.GuestPort) ||
		startup.RuntimeID != "vm:fixture-vm:fixture-user" || startup.ManagedInput {
		t.Fatal("configuration changed activation, storage, transport or process ownership")
	}
	for _, name := range []string{data, workspaces, filepath.Join(source, ".env")} {
		if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("startup configuration parsing created or changed persistent data", err)
		}
	}
}
