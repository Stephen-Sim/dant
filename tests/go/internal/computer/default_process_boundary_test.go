package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/config"
)

const computerProcessMarker = "DANT_TEST_COMPUTER_PROCESS"
const computerProcessRoot = "DANT_TEST_COMPUTER_PROCESS_ROOT"
const computerProcessExecutable = "DANT_TEST_COMPUTER_PROCESS_EXECUTABLE"
const computerProcessArguments = "DANT_TEST_COMPUTER_PROCESS_ARGUMENTS"
const computerProcessOutput = "DANT_TEST_COMPUTER_PROCESS_OUTPUT"

// Child mode only runs a copied test executable in its own fixture directory.
// It records validated SSH arguments or returns synthetic registry output;
// it never runs another command or opens a network connection.
func TestMain(tests *testing.M) {
	mode := os.Getenv(computerProcessMarker)
	if mode == "" {
		os.Exit(tests.Run())
	}
	root := os.Getenv(computerProcessRoot)
	expectedExecutable := os.Getenv(computerProcessExecutable)
	cwd, cwdErr := os.Getwd()
	executable, executableErr := os.Executable()
	rootInfo, rootErr := os.Stat(root)
	cwdInfo, cwdInfoErr := os.Stat(cwd)
	expectedInfo, expectedErr := os.Stat(expectedExecutable)
	executableInfo, executableInfoErr := os.Stat(executable)
	if !filepath.IsAbs(root) || !filepath.IsAbs(expectedExecutable) || filepath.Dir(expectedExecutable) != filepath.Join(root, "bin") || cwdErr != nil || executableErr != nil || rootErr != nil || cwdInfoErr != nil || expectedErr != nil || executableInfoErr != nil || !rootInfo.IsDir() || !os.SameFile(rootInfo, cwdInfo) || !expectedInfo.Mode().IsRegular() || !os.SameFile(expectedInfo, executableInfo) {
		os.Exit(71)
	}
	var expected []string
	if json.Unmarshal([]byte(os.Getenv(computerProcessArguments)), &expected) != nil || len(expected) == 0 {
		os.Exit(72)
	}
	arguments := os.Args[1:]
	name := filepath.Base(expectedExecutable)
	if runtime.GOOS == "windows" {
		name = strings.TrimSuffix(name, ".exe")
	}
	if mode == "registry" && name == "reg" {
		if !reflect.DeepEqual(arguments, expected) {
			os.Exit(73)
		}
		output := os.Getenv(computerProcessOutput)
		if len(output) > 4096 {
			os.Exit(74)
		}
		_, err := io.WriteString(os.Stdout, output)
		if err != nil {
			os.Exit(75)
		}
		os.Exit(0)
	}
	if mode != "ssh" || name != "ssh" || len(arguments) != len(expected)+6 || !reflect.DeepEqual(arguments[:len(expected)], expected) {
		os.Exit(76)
	}
	forward := arguments[len(expected):]
	worker := config.NativeEndpoint()
	suffix := ":" + worker.Host + ":" + strconv.Itoa(worker.Port)
	local, parseErr := strconv.Atoi(strings.TrimSuffix(forward[2], suffix))
	if forward[0] != "-N" || forward[1] != "-L" || !strings.HasSuffix(forward[2], suffix) || parseErr != nil || local < 1 || local > config.MaxPort || forward[3] != "-o" || forward[4] != "ExitOnForwardFailure=yes" || forward[5] != "fixture@192.0.2.1" {
		os.Exit(77)
	}
	file, err := os.OpenFile(filepath.Join(root, "ssh-arguments.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil || json.NewEncoder(file).Encode(arguments) != nil || file.Sync() != nil || file.Close() != nil {
		os.Exit(78)
	}
	time.Sleep(30 * time.Second)
	os.Exit(79)
}

func isolatedComputerExecutable(t *testing.T, mode, name string, arguments []string) string {
	t.Helper()
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	target := filepath.Join(bin, name)
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, source)
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil {
		t.Fatal("isolated executable copy failed", copyErr, closeErr)
	}
	encoded, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	t.Setenv(computerProcessMarker, mode)
	t.Setenv(computerProcessRoot, root)
	t.Setenv(computerProcessExecutable, target)
	t.Setenv(computerProcessArguments, string(encoded))
	t.Setenv("PATH", bin)
	return target
}

func TestDefaultSSHTunnelOwnsOnlyTheIsolatedChildAndJoinsParentCancellation(t *testing.T) {
	root := t.TempDir()
	binding := Binding{Host: "192.0.2.1", User: "fixture", Port: config.DefaultSSHPort, KeyPath: filepath.Join(root, "fixture-key"), KnownHosts: filepath.Join(root, "known-hosts")}
	isolatedComputerExecutable(t, "ssh", "ssh", SSHArgs(binding))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	tunnel, err := openSSHTunnel(ctx, binding)
	if err != nil {
		t.Fatal("default adapter could not start its isolated test child", err)
	}
	defer tunnel.Stop()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(time.Millisecond)
	defer poll.Stop()
	var arguments []string
	for {
		data, readErr := os.ReadFile(filepath.Join(os.Getenv(computerProcessRoot), "ssh-arguments.json"))
		if readErr == nil && json.Unmarshal(data, &arguments) == nil {
			break
		}
		select {
		case <-poll.C:
		case <-tunnel.Done():
			t.Fatal("isolated tunnel child rejected the generated transport arguments")
		case <-deadline.C:
			t.Fatal("isolated tunnel did not capture its validated arguments")
		}
	}
	endpoint, err := url.Parse(tunnel.Endpoint())
	forward := arguments[len(SSHArgs(binding))+2]
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || endpoint.Port() == "" || !strings.HasPrefix(forward, endpoint.Port()+":") {
		t.Fatal("local forwarding endpoint lost its exact generated port")
	}
	cancel()
	tunnel.Stop()
	select {
	case <-tunnel.Done():
	default:
		t.Fatal("parent cancellation did not join its isolated transport process")
	}
}

func TestDefaultRegistryAdapterParsesOnlyTheCapturedInstallPathValue(t *testing.T) {
	for _, fixture := range []struct {
		name, output, expected string
	}{
		{"string", "    InstallPath    REG_SZ    E:\\SyntheticRegistryInstall  \r\n", `E:\SyntheticRegistryInstall`},
		{"expand string", "    InstallPath    REG_EXPAND_SZ    %ProgramFiles%\\SyntheticVMware\r\n", `%ProgramFiles%\SyntheticVMware`},
		{"missing value", "    OtherValue    REG_SZ    rejected\r\n", ""},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			executable := isolatedComputerExecutable(t, "registry", "reg", []string{"query", "synthetic-registry-key", "/v", "InstallPath"})
			t.Setenv(computerProcessOutput, fixture.output)
			host := windowsComputerHost(t, nil)
			host.Commands.Registry = executable
			providers := NewProviders(host, ProviderDetection{})
			value, err := providers.detection.ReadRegistry(t.Context(), "synthetic-registry-key")
			if fixture.expected == "" && !errors.Is(err, ErrProviderUnavailable) || fixture.expected != "" && err != nil || value != fixture.expected {
				t.Fatal("default registry adapter accepted a missing value or changed the captured directory", err)
			}
			if fixture.name == "string" {
				root := os.Getenv(computerProcessRoot)
				deployer, err := NewDeployer(DeploymentOptions{Context: t.Context(), ProjectRoot: root, DataDir: root, Version: "fixture"})
				if err != nil {
					t.Fatal(err)
				}
				output, err := deployer.options.Run(t.Context(), executable, []string{"query", "synthetic-registry-key", "/v", "InstallPath"}, nil)
				if err != nil || string(output) != fixture.output {
					t.Fatal("default deployment runner changed or exposed the isolated child's output", err)
				}
			}
		})
	}
}
