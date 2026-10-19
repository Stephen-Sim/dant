package config

import (
	_ "embed"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strconv"
)

const (
	MaxPort                              = 65535
	APIJSONBodyBytes                     = 3 * 1024 * 1024
	InstallLeaseTTLMilliseconds          = 30000
	DesktopTransitionTimeoutMilliseconds = 150000
	VMPauseTimeoutMilliseconds           = 45000
	VMOperationTimeoutMilliseconds       = 85000
)

var ErrNetwork = errors.New("invalid_network_configuration")

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
	LoopbackHost  string        `json:"loopbackHost"`
	LoopbackHosts []string      `json:"loopbackHosts"`
	APIPort       int           `json:"apiPort"`
	DevPort       int           `json:"devPort"`
	GuestPort     int           `json:"guestPort"`
	Paths         ProtocolPaths `json:"paths"`
}

// DefaultProtocol returns a copy of generated, embedded protocol data. The
// source is src/config/protocol.json; contract generation verifies drift.
func DefaultProtocol() Protocol {
	var protocol Protocol
	if err := json.Unmarshal(protocolJSON, &protocol); err != nil {
		panic("invalid embedded protocol")
	}
	return protocol
}

type Endpoint struct {
	Host       string
	Port       int
	HTTPOrigin string
	WSOrigin   string
}

type Network struct {
	API         Endpoint
	Development Endpoint
	Guest       Endpoint
}

var portPattern = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)

func Port(value string, fallback int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	if !portPattern.MatchString(value) {
		return 0, ErrNetwork
	}
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > MaxPort {
		return 0, ErrNetwork
	}
	return port, nil
}

func Loopback(value, fallback string) (string, error) {
	if value == "" {
		value = fallback
	}
	for _, allowed := range DefaultProtocol().LoopbackHosts {
		if value == allowed {
			return value, nil
		}
	}
	return "", ErrNetwork
}

func endpoint(host string, port int) Endpoint {
	address := host + ":" + strconv.Itoa(port)
	return Endpoint{
		Host:       host,
		Port:       port,
		HTTPOrigin: (&url.URL{Scheme: "http", Host: address}).String(),
		WSOrigin:   (&url.URL{Scheme: "ws", Host: address}).String(),
	}
}

func ReadNetwork(environment map[string]string) (Network, error) {
	defaults := DefaultProtocol()
	host, err := Loopback(environment["DANT_HOST"], defaults.LoopbackHost)
	if err != nil {
		return Network{}, err
	}
	api, err := Port(environment["DANT_PORT"], defaults.APIPort)
	if err != nil {
		return Network{}, err
	}
	dev, err := Port(environment["DANT_DEV_PORT"], defaults.DevPort)
	if err != nil {
		return Network{}, err
	}
	guestHost, err := Loopback(environment["DANT_GUEST_HOST"], defaults.LoopbackHost)
	if err != nil {
		return Network{}, err
	}
	guest, err := Port(environment["DANT_GUEST_PORT"], defaults.GuestPort)
	if err != nil {
		return Network{}, err
	}
	return Network{API: endpoint(host, api), Development: endpoint(host, dev), Guest: endpoint(guestHost, guest)}, nil
}

func NativeEndpoint() Endpoint {
	defaults := DefaultProtocol()
	return endpoint(defaults.LoopbackHost, defaults.APIPort)
}

func ApplicationEndpoint(environment map[string]string, worker bool) (Endpoint, error) {
	if worker || environment["DANT_MANAGED"] != "" {
		return NativeEndpoint(), nil
	}
	network, err := ReadNetwork(environment)
	return network.API, err
}

type PublicVMEnvironment struct {
	GuestHost string `json:"DANT_GUEST_HOST"`
	GuestPort string `json:"DANT_GUEST_PORT"`
}

func PublicVMConfiguration(environment map[string]string) (PublicVMEnvironment, error) {
	defaults := DefaultProtocol()
	host, err := Loopback(environment["DANT_GUEST_HOST"], defaults.LoopbackHost)
	if err != nil {
		return PublicVMEnvironment{}, err
	}
	port, err := Port(environment["DANT_GUEST_PORT"], defaults.GuestPort)
	if err != nil {
		return PublicVMEnvironment{}, err
	}
	return PublicVMEnvironment{GuestHost: host, GuestPort: strconv.Itoa(port)}, nil
}
