package computer

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const bindingMaxBytes = 64 * 1024
const privateKeyMaxBytes = 1024 * 1024

var ErrBinding = errors.New("DANT_VM_CONFIG_INVALID")
var ErrBindingMissing = errors.New("DANT_VM_CONFIG_MISSING")
var ErrPrivateKeyMissing = errors.New("DANT_VM_KEY_MISSING")
var vmHost = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.:-]*$`)
var vmUser = regexp.MustCompile(`(?i)^[a-z_][a-z0-9_-]*$`)
var vmwareIdentity = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var printable = regexp.MustCompile(`^[^\x00-\x1f\x7f-\x9f]*$`)

type Binding struct {
	Host       string                 `json:"host"`
	User       string                 `json:"user"`
	Port       int                    `json:"port"`
	KeyPath    string                 `json:"keyPath"`
	KnownHosts string                 `json:"knownHosts"`
	Provider   contracts.VmProviderId `json:"provider,omitempty"`
	Name       string                 `json:"name,omitempty"`
	VMXPath    string                 `json:"vmxPath,omitempty"`
	VMwareID   string                 `json:"vmwareId,omitempty"`
}

type bindingInput struct {
	Host       string                 `json:"host"`
	User       string                 `json:"user"`
	Port       json.RawMessage        `json:"port"`
	KeyPath    string                 `json:"keyPath"`
	KnownHosts string                 `json:"knownHosts"`
	Provider   contracts.VmProviderId `json:"provider,omitempty"`
	Name       *string                `json:"name,omitempty"`
	VMXPath    *string                `json:"vmxPath,omitempty"`
	VMwareID   *string                `json:"vmwareId,omitempty"`
}

func NormalizeBinding(raw []byte, directory string) (Binding, error) {
	object, err := contracts.DecodeObject(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}), bindingMaxBytes)
	if err != nil {
		return Binding{}, ErrBinding
	}
	var input bindingInput
	if json.Unmarshal(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}), &input) != nil {
		return Binding{}, ErrBinding
	}
	port := 22
	if input.Port != nil {
		var value float64
		if len(input.Port) > 0 && input.Port[0] == '"' {
			var text string
			if json.Unmarshal(input.Port, &text) != nil {
				return Binding{}, ErrBinding
			}
			value, err = strconv.ParseFloat(strings.TrimSpace(text), 64)
		} else {
			err = json.Unmarshal(input.Port, &value)
		}
		if err != nil || value < 1 || value > 65535 || math.Trunc(value) != value {
			return Binding{}, ErrBinding
		}
		port = int(value)
	}

	if !vmHost.MatchString(input.Host) || !vmUser.MatchString(input.User) || strings.TrimSpace(input.KeyPath) == "" || strings.ContainsRune(input.KeyPath, 0) {
		return Binding{}, ErrBinding
	}
	absolute := func(value string) (string, error) {
		if strings.ContainsRune(value, 0) {
			return "", ErrBinding
		}
		if !filepath.IsAbs(value) {
			value = filepath.Join(directory, value)
		}
		return filepath.Abs(value)
	}
	key, err := absolute(input.KeyPath)
	if err != nil {
		return Binding{}, ErrBinding
	}
	key, err = filepath.EvalSymlinks(key)
	if err != nil {
		return Binding{}, ErrPrivateKeyMissing
	}
	keyBytes, err := files.ReadRegular(key, privateKeyMaxBytes)
	if err != nil {
		return Binding{}, ErrPrivateKeyMissing
	}

	if len(keyBytes) == 0 {
		return Binding{}, ErrBinding
	}
	clear(keyBytes)
	known := input.KnownHosts
	if known == "" {
		known = "known_hosts"
	}
	known, err = absolute(known)
	if err != nil {
		return Binding{}, ErrBinding
	}

	if info, statErr := os.Stat(known); statErr == nil {
		if !info.Mode().IsRegular() {
			return Binding{}, ErrBinding
		}
		known, err = filepath.EvalSymlinks(known)
		if err != nil {
			return Binding{}, ErrBinding
		}
	} else if errors.Is(statErr, os.ErrNotExist) {
		if info, err := os.Stat(filepath.Dir(known)); err != nil || !info.IsDir() {
			return Binding{}, ErrBinding
		}
	} else {
		return Binding{}, ErrBinding
	}
	result := Binding{Host: input.Host, User: input.User, Port: port, KeyPath: key, KnownHosts: known, Provider: input.Provider}
	if _, exists := object["provider"]; exists && !input.Provider.Valid() {
		return Binding{}, ErrBinding
	}

	if input.Name != nil {
		if !printable.MatchString(*input.Name) || strings.TrimSpace(*input.Name) == "" || len([]rune(*input.Name)) > 128 {
			return Binding{}, ErrBinding
		}
		result.Name = strings.TrimSpace(*input.Name)
	}

	if input.VMXPath != nil {
		if !printable.MatchString(*input.VMXPath) || len(*input.VMXPath) > 4096 || !filepath.IsAbs(*input.VMXPath) || !strings.EqualFold(filepath.Ext(*input.VMXPath), ".vmx") {
			return Binding{}, ErrBinding
		}
		result.VMXPath = filepath.Clean(*input.VMXPath)
	}

	if input.VMwareID != nil {
		if !vmwareIdentity.MatchString(*input.VMwareID) {
			return Binding{}, ErrBinding
		}
		result.VMwareID = strings.ToLower(*input.VMwareID)
	}

	return result, nil
}

func ReadBinding(directory string) (Binding, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return Binding{}, ErrBinding
	}
	raw, err := files.ReadRegular(filepath.Join(absolute, "vm.json"), bindingMaxBytes)
	if errors.Is(err, os.ErrNotExist) {
		return Binding{}, ErrBindingMissing
	}

	if err != nil {
		return Binding{}, ErrBinding
	}

	return NormalizeBinding(raw, absolute)
}

func SSHArgs(binding Binding) []string {
	return []string{"-T", "-p", strconv.Itoa(binding.Port), "-i", binding.KeyPath, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=" + binding.KnownHosts}
}
