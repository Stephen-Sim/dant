package runtime

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	platformruntime "runtime"
	"strings"
	"syscall"
	"testing"
)

func conversationNPMFixture(t *testing.T) (string, string, string, string) {
	t.Helper()
	root, _ := conversationEnvironmentFixture(t)
	installation, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	packageRoot := filepath.Join(installation, "lib", "node_modules", "@openai", "codex")
	command := filepath.Join(packageRoot, "bin", "codex.js")
	nativeRoot := filepath.Join(packageRoot, "node_modules", "@openai", "codex-linux-x64")
	native := filepath.Join(nativeRoot, "vendor", "x86_64-unknown-linux-musl", "bin", "codex")
	for _, directory := range []string{filepath.Dir(command), filepath.Dir(native)} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for path, body := range map[string]string{
		command: "#!/usr/bin/env node\n// Synthetic launcher; never executed.\n",
		filepath.Join(packageRoot, "package.json"): `{"name":"@openai/codex","version":"0.163.0","bin":{"codex":"bin/codex.js"},"optionalDependencies":{"@openai/codex-linux-x64":"npm:@openai/codex@0.163.0-linux-x64"}}`,
		filepath.Join(nativeRoot, "package.json"):  `{"name":"@openai/codex","version":"0.163.0-linux-x64"}`,
	} {
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	image := make([]byte, 64)
	copy(image, "\x7fELF\x02\x01\x01")
	binary.LittleEndian.PutUint16(image[16:18], 3)
	binary.LittleEndian.PutUint16(image[18:20], 62)
	binary.LittleEndian.PutUint32(image[20:24], 1)
	if err := os.WriteFile(native, image, 0o775); err != nil {
		t.Fatal(err)
	}
	return root, command, native, packageRoot
}

func TestConversationEnvironmentResolvesSelectedUserNPMInstallationToOnlyItsNativeFile(t *testing.T) {
	root, command, native, _ := conversationNPMFixture(t)
	options, err := conversationProcessOptions(root, command, []string{"app-server"})
	if err != nil {
		t.Fatal("supported per-user npm installation was rejected", err)
	}
	joined := strings.Join(options.Args, "\x00")
	if !strings.Contains(joined, "--ro-bind\x00"+native+"\x00/tool/codex") || options.Args[len(options.Args)-2] != "/tool/codex" {
		t.Fatal("conversation did not launch the selected installation's native file")
	}
	for index, argument := range options.Args {
		if (argument == "--bind" || argument == "--ro-bind") && strings.HasPrefix(options.Args[index+1], filepath.Dir(filepath.Dir(command))) && options.Args[index+1] != native {
			t.Fatal("npm launcher support exposed an installation parent")
		}
	}
}

func TestConversationNPMNativePackageAcceptsOnlyAnAbsentOrNullBin(t *testing.T) {
	for _, value := range []string{"omitted", "null", "{}", "[]", `"codex"`, "false", "0"} {
		t.Run(value, func(t *testing.T) {
			root, command, native, packageRoot := conversationNPMFixture(t)
			manifest := filepath.Join(packageRoot, "node_modules", "@openai", "codex-linux-x64", "package.json")
			if value != "omitted" {
				source, err := os.ReadFile(manifest)
				if err != nil {
					t.Fatal(err)
				}
				updated := strings.TrimSuffix(string(source), "}") + `,"bin": ` + value + "}"
				if err := os.WriteFile(manifest, []byte(updated), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			options, err := conversationProcessOptions(root, command, []string{"app-server"})
			if value == "omitted" || value == "null" {
				if err != nil || !strings.Contains(strings.Join(options.Args, "\x00"), "--ro-bind\x00"+native+"\x00/tool/codex") {
					t.Fatal("native package without a launcher lost its selected ELF", err)
				}
			} else if !errors.Is(err, ErrWorkerRole) {
				t.Fatal("unexpected native package launcher metadata was admitted", err)
			}
		})
	}
}

func TestConversationNPMCommandRejectsUnknownPackagesVersionsPlatformsAndNativeFiles(t *testing.T) {
	for _, name := range []string{"package-name", "package-version", "bin-mapping", "dependency", "native-name", "native-version", "native-bin", "native-missing", "native-script", "native-machine", "native-endian", "native-permissions", "manifest-duplicate", "manifest-oversized", "different-launcher"} {
		t.Run(name, func(t *testing.T) {
			root, command, native, packageRoot := conversationNPMFixture(t)
			path := filepath.Join(packageRoot, "package.json")
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			source := string(before)
			switch name {
			case "package-name":
				source = strings.Replace(source, `"name":"@openai/codex"`, `"name":"untrusted"`, 1)
			case "package-version":
				source = strings.Replace(source, `"version":"0.163.0"`, `"version":"0.164.0"`, 1)
			case "bin-mapping":
				source = strings.Replace(source, `"codex":"bin/codex.js"`, `"codex":"../other.js"`, 1)
			case "dependency":
				source = strings.Replace(source, `npm:@openai/codex@0.163.0-linux-x64`, `file:../other`, 1)
			case "native-name", "native-version", "native-bin":
				path = filepath.Join(packageRoot, "node_modules", "@openai", "codex-linux-x64", "package.json")
				data, readErr := os.ReadFile(path)
				if readErr != nil {
					t.Fatal(readErr)
				}
				source = string(data)
				if name == "native-name" {
					source = strings.Replace(source, "@openai/codex", "untrusted", 1)
				} else if name == "native-version" {
					source = strings.Replace(source, "0.163.0-linux-x64", "0.164.0-linux-x64", 1)
				} else {
					source = strings.TrimSuffix(source, "}") + `,"bin":{"codex":"other"}}`
				}
			case "native-missing":
				_ = os.Remove(native)
			case "native-script":
				_ = os.WriteFile(native, []byte("#!/bin/sh\n"), 0o775)
			case "native-machine", "native-endian":
				image, readErr := os.ReadFile(native)
				if readErr != nil {
					t.Fatal(readErr)
				}
				if name == "native-machine" {
					binary.LittleEndian.PutUint16(image[18:20], 183)
				} else {
					image[5] = 2
				}
				_ = os.WriteFile(native, image, 0o775)
			case "native-permissions":
				if platformruntime.GOOS == "windows" {
					_ = os.Remove(native)
					_ = os.Mkdir(native, 0o755)
				} else {
					_ = os.Chmod(native, 0o664)
				}
			case "manifest-duplicate":
				source = strings.Replace(source, `"name":`, `"name":"@openai/codex","name":`, 1)
			case "manifest-oversized":
				source = strings.Repeat(" ", 128*1024) + source
			case "different-launcher":
				other := filepath.Join(filepath.Dir(command), "other.js")
				_ = os.Rename(command, other)
				command = other
			}
			if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := conversationProcessOptions(root, command, nil); !errors.Is(err, ErrWorkerRole) {
				t.Fatal("unsupported npm launch acquired a conversation process", err)
			}
		})
	}
}

func TestConversationNPMCommandDoesNotFallBackToAnotherInstallationOrBundledVendor(t *testing.T) {
	root, command, native, packageRoot := conversationNPMFixture(t)
	image, err := os.ReadFile(native)
	if err != nil {
		t.Fatal(err)
	}
	for _, other := range []string{
		filepath.Join(packageRoot, "vendor", "x86_64-unknown-linux-musl", "bin", "codex"),
		filepath.Join(filepath.Dir(packageRoot), "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex"),
	} {
		if err := os.MkdirAll(filepath.Dir(other), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(other, image, 0o775); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(native); err != nil {
		t.Fatal(err)
	}
	if _, err := conversationProcessOptions(root, command, nil); !errors.Is(err, ErrWorkerRole) {
		t.Fatal("a broken selected installation adopted another native executable", err)
	}
}

func TestConversationCommandCaptureRejectsReplacementAndChangedFiles(t *testing.T) {
	for _, change := range []string{"replace", "modify", "parent-replace", "disappear"} {
		t.Run(change, func(t *testing.T) {
			_, command, _, packageRoot := conversationNPMFixture(t)
			captured, err := openConversationCommandFile(command, conversationNPMManifestBytes)
			if err != nil {
				t.Fatal(err)
			}
			defer captured.file.Close()
			if !captured.current() {
				t.Fatal("unchanged opened launcher did not retain its identity")
			}
			body, err := os.ReadFile(command)
			if err != nil {
				t.Fatal(err)
			}
			mutation := func(err error) bool {
				t.Helper()
				if err == nil {
					return true
				}
				var code syscall.Errno
				if platformruntime.GOOS == "windows" && errors.As(err, &code) && (code == 5 || code == 32) && captured.current() {
					// An opened Windows file can prevent replacement altogether.
					return false
				}
				t.Fatal(err)
				return false
			}
			switch change {
			case "replace":
				if !mutation(os.Rename(command, command+".retained")) {
					return
				}
				if err := os.WriteFile(command, body, 0o644); err != nil {
					t.Fatal(err)
				}
			case "modify":
				if err := os.WriteFile(command, append(body, []byte("// Changed\n")...), 0o644); err != nil {
					t.Fatal(err)
				}
			case "parent-replace":
				if !mutation(os.Rename(packageRoot, packageRoot+".retained")) {
					return
				}
				if err := os.MkdirAll(filepath.Dir(command), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(command, body, 0o644); err != nil {
					t.Fatal(err)
				}
			case "disappear":
				if !mutation(os.Remove(command)) {
					return
				}
			}
			if captured.current() {
				t.Fatal("changed launcher was adopted by a retained identity")
			}
		})
	}
}

func TestConversationCommandCaptureRejectsNonCanonicalPathsAndInvalidatedHandles(t *testing.T) {
	_, command, _, _ := conversationNPMFixture(t)
	aliased := filepath.Dir(command) + string(filepath.Separator) + ".." + string(filepath.Separator) + "bin" + string(filepath.Separator) + "codex.js"
	if _, err := openConversationCommandFile(aliased, conversationNPMManifestBytes); !errors.Is(err, ErrWorkerRole) {
		t.Fatal("noncanonical package input was adopted", err)
	}
	captured, err := openConversationCommandFile(command, conversationNPMManifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := captured.file.Close(); err != nil {
		t.Fatal(err)
	}
	if captured.current() {
		t.Fatal("closed ownership handle still authorized the selected command")
	}
}
