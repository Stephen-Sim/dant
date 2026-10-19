// Package platform describes host capabilities without starting an agent executor.
package platform

import (
	"context"
	"errors"
	"path"
	"regexp"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

var ErrHostConfiguration = errors.New("invalid_host_configuration")

// SecretProtection is supplied by the host's security owner (DPAPI on Windows).
type SecretProtection interface {
	Protect(context.Context, []byte) ([]byte, error)
	Unprotect(context.Context, []byte) ([]byte, error)
}

type Capabilities struct {
	ManagedVM        bool `json:"managedVm"`
	ExistingSSH      bool `json:"existingSsh"`
	SecretProtection bool `json:"secretProtection"`
}

type Commands struct {
	PowerShell string
	Registry   string
	Archive    string
}

type WindowsConfiguration struct {
	SystemDirectory   string
	PowerShell        string
	Archive           string
	HyperVService     string
	HyperVModule      string
	VMwareDirectories []string
	environment       map[string]string
}

type Host struct {
	ID           contracts.HostPlatformId
	OS           string
	Capabilities Capabilities
	Commands     Commands
	Windows      *WindowsConfiguration
	Protection   SecretProtection
}

var windowsAbsolute = regexp.MustCompile(`^(?:[A-Za-z]:[\\/]|[\\/])`)
var environmentVariable = regexp.MustCompile(`%([^%]+)%`)

// WindowsPath retains Windows path semantics when fixtures run on Linux.
func WindowsPath(value string) (string, error) {
	if strings.ContainsAny(value, "\x00\r\n") || !windowsAbsolute.MatchString(value) {
		return "", ErrHostConfiguration
	}
	value = strings.ReplaceAll(value, `\`, "/")
	unc := strings.HasPrefix(value, "//")
	value = path.Clean(value)
	if unc {
		value = "/" + value
	}

	return strings.ReplaceAll(value, "/", `\`), nil
}

func (configuration WindowsConfiguration) ExpandDirectory(value string) (string, error) {
	value = environmentVariable.ReplaceAllStringFunc(value, func(match string) string {
		if expanded := configuration.environment[match[1:len(match)-1]]; expanded != "" {
			return expanded
		}
		return match
	})
	return WindowsPath(value)
}

// New captures already-selected environment values once at the configuration boundary.
// The caller wires secret protection; constructing a host never performs a command.
func New(goos string, environment map[string]string, protection SecretProtection) (Host, error) {
	host := Host{OS: goos, ID: contracts.HostPlatformIdUnsupported, Protection: protection}
	switch goos {
	case "windows", "win32":
		host.ID = contracts.HostPlatformIdWindows
	case "darwin":
		host.ID = contracts.HostPlatformIdMacOS
	case "linux":
		host.ID = contracts.HostPlatformIdLinux
	}
	host.Commands.Archive = "tar"
	if host.ID == contracts.HostPlatformIdWindows {
		selectDirectory := func(key, fallback string) (string, error) {
			value := environment[key]
			if value == "" {
				value = fallback
			}
			return WindowsPath(value)
		}
		systemRoot, err := selectDirectory("SystemRoot", `C:\Windows`)
		if err != nil {
			return Host{}, err
		}
		programFiles, err := selectDirectory("ProgramFiles", `C:\Program Files`)
		if err != nil {
			return Host{}, err
		}
		programFilesX86, err := selectDirectory("ProgramFiles(x86)", `C:\Program Files (x86)`)
		if err != nil {
			return Host{}, err
		}
		captured := make(map[string]string, len(environment))
		for key, value := range environment {
			captured[key] = value
		}
		system := strings.TrimRight(systemRoot, `\`) + `\System32`
		host.Windows = &WindowsConfiguration{
			SystemDirectory:   system,
			PowerShell:        system + `\WindowsPowerShell\v1.0\powershell.exe`,
			Archive:           system + `\tar.exe`,
			HyperVService:     system + `\vmms.exe`,
			HyperVModule:      system + `\WindowsPowerShell\v1.0\Modules\Hyper-V\Hyper-V.psd1`,
			VMwareDirectories: []string{programFilesX86 + `\VMware\VMware Workstation`, programFiles + `\VMware\VMware Workstation`},
			environment:       captured,
		}
		host.Commands = Commands{PowerShell: "powershell.exe", Registry: "reg.exe", Archive: host.Windows.Archive}
	}
	host.Capabilities = Capabilities{
		ManagedVM:        host.Windows != nil,
		ExistingSSH:      host.ID != contracts.HostPlatformIdUnsupported,
		SecretProtection: protection != nil,
	}

	return host, nil
}
