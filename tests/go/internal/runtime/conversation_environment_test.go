package runtime

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	platformruntime "runtime"
	"strings"
	"testing"
)

func conversationEnvironmentFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"home", "config", "work", "managed"} {
		if err := os.Mkdir(filepath.Join(root, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "managed", "requirements.toml"), []byte(conversationManagedRequirements), 0o600); err != nil {
		t.Fatal(err)
	}
	command := filepath.Join(t.TempDir(), "synthetic-codex")
	if err := os.WriteFile(command, []byte("synthetic executable fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root, command
}

func TestConversationEnvironmentMountsOnlyPrivateWritableStateAndFixedReadOnlyRuntime(t *testing.T) {
	root, command := conversationEnvironmentFixture(t)
	t.Setenv("DISPLAY", "synthetic-display")
	t.Setenv("DANT_CREDENTIAL_BRIDGE_TOKEN", "synthetic-service-token")
	t.Setenv("NODE_OPTIONS", "synthetic-inherited-node-option")
	arguments := []string{"app-server", "--listen", "stdio://"}
	options, err := conversationProcessOptions(root, command, arguments)
	if err != nil {
		t.Fatal(err)
	}
	if options.Command != "/usr/bin/bwrap" || options.Directory != root || options.Environment == nil {
		t.Fatal("conversation did not use an explicit namespace launch")
	}
	joined := strings.Join(options.Args, "\x00")
	for _, required := range []string{"--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--cap-drop\x00ALL", "--proc\x00/proc", "--dev\x00/dev", "--tmpfs\x00/tmp", "--remount-ro\x00/", "--chdir\x00/conversation/work"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("required namespace capability missing: %s", required)
		}
	}
	writable := map[string]string{}
	readonly := map[string]string{}
	for index, argument := range options.Args {
		if argument == "--bind" || argument == "--ro-bind" {
			if index+2 >= len(options.Args) {
				t.Fatal("incomplete mount")
			}
			target := writable
			if argument == "--ro-bind" {
				target = readonly
			}
			target[options.Args[index+2]] = options.Args[index+1]
		}
	}
	if !reflect.DeepEqual(writable, map[string]string{
		"/conversation/home": filepath.Join(root, "home"), "/conversation/config": filepath.Join(root, "config"), "/conversation/work": filepath.Join(root, "work"),
	}) {
		t.Fatal("writable namespace exposed a parent or service directory")
	}
	for _, name := range []string{"/usr", "/bin", "/lib", "/etc/ssl", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group"} {
		if readonly[name] != name {
			t.Fatalf("read-only runtime path missing: %s", name)
		}
	}
	if readonly["/etc/codex/requirements.toml"] != filepath.Join(root, "managed", "requirements.toml") || readonly["/tool/codex"] != command {
		t.Fatal("managed policy or executable was not mounted explicitly")
	}
	for _, forbidden := range []string{"/", "/home", "/run", "/sys", "/etc"} {
		if readonly[forbidden] != "" || writable[forbidden] != "" {
			t.Fatal("host configuration escaped the allowlist")
		}
	}
	environment := strings.Join(options.Environment, "\n")
	for _, forbidden := range []string{"DISPLAY", "DANT_", "NODE_OPTIONS", "OPENAI_", "XDG_", "DBUS_"} {
		if strings.Contains(environment, forbidden) {
			t.Fatal("an inherited provider, display or service value escaped")
		}
	}
	for _, required := range []string{"HOME=/conversation/home", "CODEX_HOME=/conversation/config", "PWD=/conversation/work", "PATH=/usr/local/bin:/usr/bin:/bin"} {
		if !strings.Contains(environment, required) {
			t.Fatal("private process environment missing")
		}
	}
	if !reflect.DeepEqual(options.Args[len(options.Args)-4:], []string{"/tool/codex", "app-server", "--listen", "stdio://"}) {
		t.Fatal("resolved command or RPC arguments changed")
	}
}

func TestConversationEnvironmentRejectsInheritedStateMissingPolicyAndUnsafeLaunchers(t *testing.T) {
	for _, name := range []string{"missing-root", "missing-directory", "extra-config", "wrong-policy", "oversized-policy", "missing-command", "script-command", "null-argument"} {
		t.Run(name, func(t *testing.T) {
			root, command := conversationEnvironmentFixture(t)
			arguments := []string{"app-server"}
			switch name {
			case "missing-root":
				root = filepath.Join(root, "absent")
			case "missing-directory":
				_ = os.Remove(filepath.Join(root, "config"))
			case "extra-config":
				_ = os.WriteFile(filepath.Join(root, "config", "config.toml"), []byte("untrusted"), 0o600)
			case "wrong-policy":
				_ = os.WriteFile(filepath.Join(root, "managed", "requirements.toml"), []byte("[mcp_servers]\r"), 0o600)
			case "oversized-policy":
				_ = os.WriteFile(filepath.Join(root, "managed", "requirements.toml"), []byte(strings.Repeat("x", 1000)), 0o600)
			case "missing-command":
				command += ".absent"
			case "script-command":
				_ = os.WriteFile(command, []byte("#!/usr/bin/env node\nrequire('./private-vendor')"), 0o600)
			case "null-argument":
				arguments = []string{"app-server\x00untrusted"}
			}
			if _, err := conversationProcessOptions(root, command, arguments); !errors.Is(err, ErrWorkerRole) {
				t.Fatal("unsafe conversation environment was admitted")
			}
		})
	}
}

func TestConversationEnvironmentRetainsUsrLauncherPathAndRejectsMissingExternalMapping(t *testing.T) {
	command, mounts, err := conversationCommandMapping("/usr/local/lib/node_modules/@openai/codex/bin/codex.js")
	if err != nil || command != "/usr/local/lib/node_modules/@openai/codex/bin/codex.js" || len(mounts) != 0 {
		t.Fatal("the pinned npm launcher lost its sibling vendor path")
	}
	if _, _, err := conversationCommandMapping(filepath.Join(t.TempDir(), "absent")); !errors.Is(err, ErrWorkerRole) {
		t.Fatal("missing external command was admitted")
	}
}

func TestConversationEnvironmentRequiresPrivateModesOnLinux(t *testing.T) {
	root, command := conversationEnvironmentFixture(t)
	if err := os.Chmod(filepath.Join(root, "managed", "requirements.toml"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := conversationProcessOptions(root, command, nil)
	if platformruntime.GOOS == "windows" {
		if err != nil {
			t.Fatal("Windows fixture ACL semantics were mistaken for a Linux deployment")
		}
	} else if !errors.Is(err, ErrWorkerRole) {
		t.Fatal("shared policy permissions were admitted")
	}
}
