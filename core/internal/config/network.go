package config

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"
)

const (
	ProtocolResourcePath                 = "resources/config/protocol.json"
	MaxPort                              = 65535
	DefaultSSHPort                       = 22
	APIJSONBodyBytes                     = 3 * 1024 * 1024
	InstallLeaseTTLMilliseconds          = 30000
	DesktopTransitionTimeoutMilliseconds = 150000
	VMPauseTimeoutMilliseconds           = 45000
	VMOperationTimeoutMilliseconds       = 85000
)

var ErrNetwork = errors.New("invalid_network_configuration")

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
		if fallback < 1 || fallback > MaxPort {
			return 0, ErrNetwork
		}
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
	if err != nil || !workerGuestPort(guest, defaults) {
		return Network{}, ErrNetwork
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
	if err != nil || !workerGuestPort(port, defaults) {
		return PublicVMEnvironment{}, ErrNetwork
	}
	return PublicVMEnvironment{GuestHost: host, GuestPort: strconv.Itoa(port)}, nil
}

// These listeners share the VM's loopback interface. Host development ports
// belong to another machine and do not reserve a port in the guest.
func workerGuestPort(port int, protocol Protocol) bool {
	return port != protocol.APIPort && port != protocol.BootstrapGuestPort
}
