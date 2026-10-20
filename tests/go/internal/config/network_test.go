package config

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestEmbeddedProtocolMatchesCanonicalUIAndNativeSource(t *testing.T) {
	canonical, err := os.ReadFile("../../../" + ProtocolResourcePath)
	if err != nil || !bytes.Equal(canonical, protocolJSON) {
		t.Fatal("generated network protocol drifted")
	}
	protocol := DefaultProtocol()
	if protocol.APIPort != 4317 || protocol.GuestPort != 4320 || protocol.Paths.Session != "/api/session" {
		t.Fatal("native transport contract changed")
	}
	protocol.LoopbackHosts[0] = "attacker.invalid"
	if DefaultProtocol().LoopbackHosts[0] != "127.0.0.1" {
		t.Fatal("protocol mutation escaped its caller")
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
	if _, err := Loopback("0.0.0.0", "127.0.0.1"); err == nil {
		t.Fatal("public network binding accepted")
	}
}
