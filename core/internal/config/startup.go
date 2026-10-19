package config

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

type Role string

const (
	RoleController      Role = "controller"
	RoleWorker          Role = "worker"
	RolePrepareWorker   Role = "prepare-worker"
	RoleBackupTransform Role = "backup-transform"
	RoleBackupCLI       Role = "backup-cli"
	RoleWorkerBackup    Role = "worker-backup"
	RoleMemoryShadow    Role = "memory-shadow"
)

func (role Role) Valid() bool {
	return slices.Contains([]Role{RoleController, RoleWorker, RolePrepareWorker, RoleBackupTransform, RoleBackupCLI, RoleWorkerBackup, RoleMemoryShadow}, role)
}

var ErrStartup = errors.New("invalid_startup_configuration")

const MaxEnvBytes = 64 * 1024

var environmentKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type Startup struct {
	Role          Role
	Root          string
	DataDir       string
	Home          string
	WorkspaceRoot string
	RuntimeID     string
	Environment   map[string]string
	Network       Network
	Listen        Endpoint
	PrepareOnly   bool
	DeployWorker  bool
	Backup        string
	ManagedInput  bool
}

type StartupInput struct {
	Arguments        []string
	Environment      []string
	WorkingDirectory string
	Executable       string
	Home             string
	Hostname         string
	Username         string
}

func CaptureEnvironment(entries []string) map[string]string {
	result := map[string]string{}
	for _, entry := range entries {
		key, value, ok := strings.Cut(entry, "=")
		if ok && key != "" && !strings.ContainsRune(key, 0) && !strings.ContainsRune(value, 0) {
			result[key] = value
		}
	}
	return result
}

func EnvironmentList(environment map[string]string) []string {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+environment[key])
	}
	return result
}

func configPath(value, base string) (string, error) {
	if value == "" || !utf8.ValidString(value) || strings.ContainsAny(value, "\x00\r\n") {
		return "", ErrStartup
	}
	if !filepath.IsAbs(value) {
		value = filepath.Join(base, value)
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", ErrStartup
	}
	return filepath.Clean(absolute), nil
}

func LoadStartup(input StartupInput) (Startup, error) {
	result := Startup{Role: RoleController, Home: input.Home, Environment: CaptureEnvironment(input.Environment)}
	root := input.WorkingDirectory
	configurationRoot := ""
	data := ""
	workspaceArgument := ""
	seen := map[string]bool{}
	for index := 0; index < len(input.Arguments); index++ {
		argument := input.Arguments[index]
		key, value, hasValue := strings.Cut(argument, "=")
		switch key {
		case "--role", "--root", "--config-root", "--data-dir", "--workspace-root", "--backup":
			if seen[key] {
				return Startup{}, ErrStartup
			}
			seen[key] = true
			if !hasValue {
				index++
				if index >= len(input.Arguments) {
					return Startup{}, ErrStartup
				}
				value = input.Arguments[index]
			}
			if value == "" {
				return Startup{}, ErrStartup
			}
			switch key {
			case "--role":
				result.Role = Role(value)
			case "--root":
				root = value
			case "--config-root":
				configurationRoot = value
			case "--data-dir":
				data = value
			case "--workspace-root":
				workspaceArgument = value
			case "--backup":
				result.Backup = value
			}
		case "--vm-worker":
			if hasValue || seen["--role"] {
				return Startup{}, ErrStartup
			}
			seen["--role"] = true
			result.Role = RoleWorker
		case "--prepare":
			if hasValue || result.PrepareOnly {
				return Startup{}, ErrStartup
			}
			result.PrepareOnly = true
		case "--deploy-worker":
			if hasValue || result.DeployWorker {
				return Startup{}, ErrStartup
			}
			result.DeployWorker = true
		default:
			return Startup{}, ErrStartup
		}
	}
	if !result.Role.Valid() {
		return Startup{}, ErrStartup
	}
	var err error
	result.Root, err = configPath(root, input.WorkingDirectory)
	if err != nil {
		return Startup{}, err
	}
	if configurationRoot == "" {
		configurationRoot = result.Root
	}
	configurationRoot, err = configPath(configurationRoot, input.WorkingDirectory)
	if err != nil {
		return Startup{}, err
	}
	result.Environment, err = LoadProjectEnvironment(configurationRoot, result.Environment)
	if err != nil {
		return Startup{}, err
	}
	managed := result.Environment["DANT_MANAGED_STDIN"]
	if managed != "" && managed != "0" && managed != "1" {
		return Startup{}, ErrStartup
	}
	result.ManagedInput = result.Environment["DANT_MANAGED"] != "" || managed == "1"
	if data == "" {
		data = result.Environment["DANT_DATA"]
	}
	if data == "" {
		data = filepath.Join(result.Root, "data")
	}
	result.DataDir, err = configPath(data, result.Root)
	if err != nil {
		return Startup{}, err
	}
	result.Home, err = configPath(input.Home, input.WorkingDirectory)
	if err != nil {
		return Startup{}, err
	}
	workspace := result.Environment["DANT_WORKSPACE_ROOT"]
	if workspaceArgument != "" {
		workspace = workspaceArgument
	}
	if workspace == "" {
		workspace = filepath.Join(result.Home, "dant", "workspaces")
	}
	result.WorkspaceRoot, err = configPath(workspace, result.Root)
	if err != nil {
		return Startup{}, err
	}
	result.RuntimeID = result.Environment["DANT_RUNTIME_ID"]
	if result.RuntimeID == "" {
		result.RuntimeID = "vm:" + input.Hostname + ":" + input.Username
	}
	if len(result.RuntimeID) > 256 || strings.ContainsAny(result.RuntimeID, "\x00\r\n") {
		return Startup{}, ErrStartup
	}
	result.Network, err = ReadNetwork(result.Environment)
	if err != nil {
		return Startup{}, err
	}
	result.Listen, err = ApplicationEndpoint(result.Environment, result.Role == RoleWorker)
	if err != nil {
		return Startup{}, err
	}
	if (result.PrepareOnly || result.DeployWorker) && result.Role != RoleController {
		return Startup{}, ErrStartup
	}
	if result.Backup != "" {
		if result.Role != RolePrepareWorker {
			return Startup{}, ErrStartup
		}
		result.Backup, err = configPath(result.Backup, result.Root)
		if err != nil {
			return Startup{}, err
		}
	}
	return result, nil
}

// ParseEnvironment implements the documented .env subset without substitution:
// literal single/backtick quotes, multiline quotes and double-quoted \n values.
// Existing process values take priority; .env.example is never loaded.
func ParseEnvironment(data []byte) (map[string]string, error) {
	if len(data) > MaxEnvBytes || !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		return nil, ErrStartup
	}
	source := strings.ReplaceAll(string(data), "\r", "")
	result := map[string]string{}
	for source != "" {
		source = strings.TrimLeft(source, " \t\n")
		if source == "" {
			break
		}
		if source[0] == '#' {
			_, source, _ = strings.Cut(source, "\n")
			continue
		}
		if strings.HasPrefix(source, "export ") {
			source = strings.TrimLeft(source[7:], " \t")
		}
		equals := strings.IndexByte(source, '=')
		newline := strings.IndexByte(source, '\n')
		if equals < 0 || newline >= 0 && newline < equals {
			_, source, _ = strings.Cut(source, "\n")
			continue
		}
		key := strings.Trim(source[:equals], " \t")
		if !environmentKey.MatchString(key) {
			return nil, ErrStartup
		}
		source = strings.TrimLeft(source[equals+1:], " \t")
		var value string
		if len(source) > 0 && strings.ContainsRune("\"'`", rune(source[0])) {
			quote := source[0]
			end := strings.IndexByte(source[1:], quote)
			if end >= 0 {
				value = source[1 : end+1]
				_, source, _ = strings.Cut(source[end+2:], "\n")
				if quote == '"' {
					value = strings.ReplaceAll(value, `\n`, "\n")
				}
			} else {
				value, source, _ = strings.Cut(source, "\n")
				if comment := strings.IndexByte(value, '#'); comment >= 0 {
					value = value[:comment]
				}
				value = strings.Trim(value, " \t")
			}
		} else {
			value, source, _ = strings.Cut(source, "\n")
			if comment := strings.IndexByte(value, '#'); comment >= 0 {
				value = value[:comment]
			}
			value = strings.Trim(value, " \t")
		}
		result[key] = value
	}
	return result, nil
}

func LoadProjectEnvironment(root string, current map[string]string) (map[string]string, error) {
	result := make(map[string]string, len(current))
	for key, value := range current {
		result[key] = value
	}
	data, err := files.ReadRegular(filepath.Join(root, ".env"), MaxEnvBytes)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return nil, ErrStartup
	}
	parsed, err := ParseEnvironment(data)
	if err != nil {
		return nil, err
	}
	for key, value := range parsed {
		if _, present := result[key]; !present {
			result[key] = value
		}
	}
	return result, nil
}
