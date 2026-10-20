package config

import (
	"bytes"
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

func TestEmbeddedProtocolMatchesCanonicalUIAndNativeSource(t *testing.T) {
	canonical, err := os.ReadFile("../../../" + ProtocolResourcePath)
	if err != nil || !bytes.Equal(canonical, protocolJSON) {
		t.Fatal("generated network protocol drifted")
	}
	protocol := DefaultProtocol()
	if protocol.APIPort != 4317 || protocol.DevPort != 4318 || protocol.BootstrapGuestPort != 4319 || protocol.GuestPort != 4321 || protocol.Paths.Session != "/api/session" {
		t.Fatal("native transport contract changed")
	}
	protocol.LoopbackHosts[0] = "attacker.invalid"
	if DefaultProtocol().LoopbackHosts[0] != "127.0.0.1" {
		t.Fatal("protocol mutation escaped its caller")
	}
}

func TestGuestDefaultUsesTheCanonicalListenerAndPreservesAnExplicitLegacyPort(t *testing.T) {
	for _, item := range []struct {
		name        string
		environment map[string]string
		port        int
	}{
		{"omitted", map[string]string{}, DefaultProtocol().GuestPort},
		{"empty", map[string]string{"DANT_GUEST_PORT": ""}, DefaultProtocol().GuestPort},
		{"explicit legacy", map[string]string{"DANT_GUEST_PORT": "4320"}, 4320},
	} {
		t.Run(item.name, func(t *testing.T) {
			network, err := ReadNetwork(item.environment)
			if err != nil || network.Guest.Port != item.port {
				t.Fatal("guest configuration changed the canonical default or an explicit port", err)
			}
			public, err := PublicVMConfiguration(item.environment)
			if err != nil || public.GuestPort != strconv.Itoa(item.port) {
				t.Fatal("deployment did not preserve the selected guest listener", err)
			}
		})
	}
}

func TestWorkerGuestConfigurationReservesOnlyPortsOwnedInsideTheVM(t *testing.T) {
	protocol := DefaultProtocol()
	for _, port := range []int{protocol.APIPort, protocol.BootstrapGuestPort} {
		environment := map[string]string{"DANT_GUEST_PORT": strconv.Itoa(port)}
		if _, err := ReadNetwork(environment); err != ErrNetwork {
			t.Fatal("guest configuration accepted a VM listener collision", port, err)
		}
		if _, err := PublicVMConfiguration(environment); err != ErrNetwork {
			t.Fatal("deployment exported a VM listener collision", port, err)
		}
	}
	for _, port := range []int{protocol.DevPort, protocol.GuestPort, 65535} {
		environment := map[string]string{"DANT_GUEST_PORT": strconv.Itoa(port)}
		actual, err := ReadNetwork(environment)
		if err != nil || actual.Guest.Port != port {
			t.Fatal("unreserved custom guest port rejected", port, err)
		}
		public, err := PublicVMConfiguration(environment)
		if err != nil || public.GuestPort != strconv.Itoa(port) {
			t.Fatal("valid deployment guest setting lost", public, err)
		}
	}
}

func TestNetworkRejectsUnknownBindingAndOnlyExportsPublicVMConfiguration(t *testing.T) {
	environment := map[string]string{"DANT_HOST": "localhost", "DANT_PORT": "4455", "OPENAI_API_KEY": "fixture-secret-value", "PRIVATE_SETTING": "fixture-private"}
	network, err := ReadNetwork(environment)
	if err != nil || network.API.HTTPOrigin != "http://localhost:4455" {
		t.Fatal("validated development endpoint unavailable")
	}
	managed, err := ApplicationEndpoint(map[string]string{"DANT_MANAGED": "1", "DANT_PORT": "4455"}, false)
	if err != nil || managed.HTTPOrigin != "http://127.0.0.1:4317" {
		t.Fatal("managed host protocol was changed by a development option")
	}
	public, err := PublicVMConfiguration(environment)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(public)
	if err != nil || bytes.Contains(encoded, []byte("fixture-")) {
		t.Fatal("private environment copied to VM configuration")
	}
	for _, value := range []string{"0", "65536", "4317x", "04317", "-1", "1.5"} {
		if _, err := Port(value, 4317); err == nil {
			t.Fatal("invalid transport port accepted")
		}
	}
	for _, fallback := range []int{-1, 0, MaxPort + 1} {
		if _, err := Port("", fallback); err == nil {
			t.Fatal("invalid default transport port accepted")
		}
	}
	if _, err := Loopback("0.0.0.0", "127.0.0.1"); err == nil {
		t.Fatal("public network binding accepted")
	}
}
