package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestProtocolRejectsInvalidCanonicalResource(t *testing.T) {
	tests := []struct {
		name   string
		change func(map[string]json.RawMessage)
	}{
		{"unknown key", func(value map[string]json.RawMessage) { value["override"] = json.RawMessage(`true`) }},
		{"missing key", func(value map[string]json.RawMessage) { delete(value, "devPort") }},
		{"public host", func(value map[string]json.RawMessage) { value["loopbackHost"] = json.RawMessage(`"0.0.0.0"`) }},
		{"alias primary", func(value map[string]json.RawMessage) { value["loopbackHost"] = json.RawMessage(`"localhost"`) }},
		{"null host", func(value map[string]json.RawMessage) { value["loopbackHost"] = json.RawMessage(`null`) }},
		{"extra alias", func(value map[string]json.RawMessage) {
			value["loopbackHosts"] = json.RawMessage(`["127.0.0.1","localhost","remote"]`)
		}},
		{"duplicate alias", func(value map[string]json.RawMessage) {
			value["loopbackHosts"] = json.RawMessage(`["127.0.0.1","127.0.0.1"]`)
		}},
		{"missing alias", func(value map[string]json.RawMessage) { value["loopbackHosts"] = json.RawMessage(`["127.0.0.1"]`) }},
		{"bad alias type", func(value map[string]json.RawMessage) { value["loopbackHosts"] = json.RawMessage(`["127.0.0.1",0]`) }},
		{"null aliases", func(value map[string]json.RawMessage) { value["loopbackHosts"] = json.RawMessage(`null`) }},
		{"zero port", func(value map[string]json.RawMessage) { value["apiPort"] = json.RawMessage(`0`) }},
		{"oversize port", func(value map[string]json.RawMessage) { value["apiPort"] = json.RawMessage(`65536`) }},
		{"negative port", func(value map[string]json.RawMessage) { value["apiPort"] = json.RawMessage(`-1`) }},
		{"fractional port", func(value map[string]json.RawMessage) { value["apiPort"] = json.RawMessage(`4317.5`) }},
		{"string port", func(value map[string]json.RawMessage) { value["apiPort"] = json.RawMessage(`"4317"`) }},
		{"null port", func(value map[string]json.RawMessage) { value["apiPort"] = json.RawMessage(`null`) }},
		{"duplicate port", func(value map[string]json.RawMessage) { value["devPort"] = value["apiPort"] }},
		{"missing bootstrap port", func(value map[string]json.RawMessage) { delete(value, "bootstrapGuestPort") }},
		{"colliding bootstrap port", func(value map[string]json.RawMessage) { value["bootstrapGuestPort"] = value["guestPort"] }},
		{"null bootstrap port", func(value map[string]json.RawMessage) { value["bootstrapGuestPort"] = json.RawMessage(`null`) }},
		{"null paths", func(value map[string]json.RawMessage) { value["paths"] = json.RawMessage(`null`) }},
		{"missing path", func(value map[string]json.RawMessage) { value["paths"] = json.RawMessage(`{}`) }},
	}
	for _, item := range tests {
		t.Run(item.name, func(t *testing.T) {
			var value map[string]json.RawMessage
			if err := json.Unmarshal(protocolJSON, &value); err != nil {
				t.Fatal(err)
			}
			item.change(value)
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := parseProtocol(raw); !errors.Is(err, ErrNetwork) {
				t.Fatal("invalid protocol accepted", err)
			}
		})
	}

	for _, replacement := range []string{`null`, `""`, `"//host"`, `"/api/../state"`, `"/api/"`, `"/api?q=1"`, `"/健康"`, `"` + strings.Repeat("a", maxProtocolPathBytes+1) + `"`, `"/api/session"`, `"/other/state"`} {
		raw := bytes.Replace(protocolJSON, []byte(`"/api/state"`), []byte(replacement), 1)
		if _, err := parseProtocol(raw); !errors.Is(err, ErrNetwork) {
			t.Fatal("invalid path accepted", replacement, err)
		}
	}
	for _, raw := range [][]byte{
		nil, []byte(`[]`), []byte(`null`), []byte(`{`), []byte{0xff},
		append(bytes.Clone(protocolJSON), []byte(`{}`)...),
		bytes.Replace(protocolJSON, []byte(`"apiPort":`), []byte(`"apiPort":1,"apiPort":`), 1),
		bytes.Replace(protocolJSON, []byte(`"state":`), []byte(`"st\u0061te":"/duplicate","state":`), 1),
		append(bytes.Repeat([]byte(" "), maxProtocolBytes), protocolJSON...),
		bytes.Replace(protocolJSON, []byte(`"health":`), []byte(`"unexpected":`), 1),
	} {
		if _, err := parseProtocol(raw); !errors.Is(err, ErrNetwork) {
			t.Fatal("malformed protocol accepted", err)
		}
	}
}

func TestProtocolParsesChangedCanonicalPortsAndRoutesWithoutFallback(t *testing.T) {
	protocol := DefaultProtocol()
	protocol.APIPort, protocol.DevPort, protocol.BootstrapGuestPort, protocol.GuestPort = 5001, 5002, 5003, 5004
	protocol.LoopbackHosts = []string{loopbackHostAlias, primaryLoopbackHost}
	protocol.Paths.API = "/test-api"
	protocol.Paths.Session = "/test-api/session"
	protocol.Paths.Version = "/test-api/version"
	protocol.Paths.State = "/test-api/state"
	raw, err := json.Marshal(protocol)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := parseProtocol(raw)
	if err != nil || actual.APIPort != 5001 || actual.Paths.State != "/test-api/state" {
		t.Fatal("valid alternate canonical values lost", actual, err)
	}
	if mustProtocol(raw).BootstrapGuestPort != 5003 || mustProtocol(raw).GuestPort != 5004 {
		t.Fatal("validated protocol changed")
	}
}

func TestInvalidEmbeddedProtocolFailsBeforeServicesStart(t *testing.T) {
	defer func() {
		if recover() != "invalid embedded protocol" {
			t.Fatal("invalid embedded configuration did not stop startup")
		}
	}()
	mustProtocol([]byte(`{"token":"private-not-in-error"}`))
}
