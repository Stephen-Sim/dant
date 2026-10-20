package config

import (
	_ "embed"
	"encoding/json"
	"regexp"
	"slices"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	maxProtocolBytes     = 64 * 1024
	maxProtocolPathBytes = 128
	primaryLoopbackHost  = "127.0.0.1"
	loopbackHostAlias    = "localhost"
)

//go:embed assets/protocol.json
var protocolJSON []byte

type ProtocolPaths struct {
	API      string `json:"api"`
	Events   string `json:"events"`
	Session  string `json:"session"`
	Version  string `json:"version"`
	State    string `json:"state"`
	Health   string `json:"health"`
	Screen   string `json:"screen"`
	Input    string `json:"input"`
	Control  string `json:"control"`
	File     string `json:"file"`
	ReadFile string `json:"readFile"`
}

type Protocol struct {
	LoopbackHost       string        `json:"loopbackHost"`
	LoopbackHosts      []string      `json:"loopbackHosts"`
	APIPort            int           `json:"apiPort"`
	DevPort            int           `json:"devPort"`
	BootstrapGuestPort int           `json:"bootstrapGuestPort"`
	GuestPort          int           `json:"guestPort"`
	Paths              ProtocolPaths `json:"paths"`
}

var (
	protocolPathPattern = regexp.MustCompile(`^/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*$`)
	embeddedProtocol    = mustProtocol(protocolJSON)
)

// The native transport is a build contract. Validate it once, before service
// assembly, and never substitute defaults for an invalid embedded resource.
func mustProtocol(raw []byte) Protocol {
	protocol, err := parseProtocol(raw)
	if err != nil {
		panic("invalid embedded protocol")
	}
	return protocol
}

func parseProtocol(raw []byte) (Protocol, error) {
	object, err := contracts.DecodeObject(raw, maxProtocolBytes)
	if err != nil || len(object) != 7 {
		return Protocol{}, ErrNetwork
	}
	for _, key := range []string{"loopbackHost", "loopbackHosts", "apiPort", "devPort", "bootstrapGuestPort", "guestPort", "paths"} {
		if _, exists := object[key]; !exists {
			return Protocol{}, ErrNetwork
		}
	}
	var protocol Protocol
	if json.Unmarshal(raw, &protocol) != nil || protocol.LoopbackHost != primaryLoopbackHost {
		return Protocol{}, ErrNetwork
	}
	if len(protocol.LoopbackHosts) != 2 ||
		!slices.Contains(protocol.LoopbackHosts, primaryLoopbackHost) ||
		!slices.Contains(protocol.LoopbackHosts, loopbackHostAlias) {
		return Protocol{}, ErrNetwork
	}

	ports := []int{protocol.APIPort, protocol.DevPort, protocol.BootstrapGuestPort, protocol.GuestPort}
	seenPorts := make(map[int]bool, len(ports))
	for _, port := range ports {
		if port < 1 || port > MaxPort || seenPorts[port] {
			return Protocol{}, ErrNetwork
		}
		seenPorts[port] = true
	}

	paths, err := contracts.DecodeObject(object["paths"], maxProtocolBytes)
	if err != nil || len(paths) != 11 {
		return Protocol{}, ErrNetwork
	}
	seenPaths := make(map[string]bool, len(paths))
	for _, key := range []string{"api", "events", "session", "version", "state", "health", "screen", "input", "control", "file", "readFile"} {
		var value string
		if json.Unmarshal(paths[key], &value) != nil || len(value) < 2 ||
			len(value) > maxProtocolPathBytes || !protocolPathPattern.MatchString(value) || seenPaths[value] {
			return Protocol{}, ErrNetwork
		}
		seenPaths[value] = true
	}
	for _, value := range []string{protocol.Paths.Session, protocol.Paths.Version, protocol.Paths.State} {
		if !strings.HasPrefix(value, protocol.Paths.API+"/") {
			return Protocol{}, ErrNetwork
		}
	}
	return protocol, nil
}

// DefaultProtocol returns an independent copy of the validated canonical data.
// Generation checks assets/protocol.json against resources/config/protocol.json.
func DefaultProtocol() Protocol {
	protocol := embeddedProtocol
	protocol.LoopbackHosts = slices.Clone(protocol.LoopbackHosts)
	return protocol
}
