package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestComputerResourcesMatchCanonicalBytesAndReturnIndependentValues(t *testing.T) {
	canonical, err := os.ReadFile("../../../" + ComputerResourcePath)
	if err != nil || !bytes.Equal(canonical, computerResourceJSON) {
		t.Fatal("generated computer resource drifted")
	}
	value := DefaultComputerResources()
	if value.CPU.Default != 4 || value.MemoryGB.Default != 8 || value.DiskGB.Default != 64 {
		t.Fatal("provisioning defaults changed")
	}
	value.CPU.Default = 40
	if DefaultComputerResources().CPU.Default != 4 {
		t.Fatal("caller changed the shared provisioning policy")
	}
}

func TestComputerResourcesUseValidatedSourceValuesWithoutInventingPolicyFallbacks(t *testing.T) {
	raw := []byte(`{"cpu":{"default":7,"min":3,"max":11},"memoryGB":{"default":19,"min":5,"max":29},"diskGB":{"default":137,"min":73,"max":257}}`)
	value, err := ParseComputerResources(raw)
	if err != nil || value.CPU.Default != 7 || value.MemoryGB.Min != 5 || value.DiskGB.Max != 257 {
		t.Fatal("resource values were replaced by hidden defaults")
	}
	for _, resource := range []ResourceRange{value.CPU, value.MemoryGB, value.DiskGB} {
		if !resource.Contains(resource.Default) || !resource.Contains(resource.Min) || !resource.Contains(resource.Max) ||
			resource.Contains(resource.Min-1) || resource.Contains(resource.Max+1) {
			t.Fatal("resource boundaries did not match their source")
		}
	}
	if _, err := ParseComputerResources([]byte(`{"cpu":{"default":1,"min":1,"max":1},"memoryGB":{"default":1,"min":1,"max":1},"diskGB":{"default":1,"min":1,"max":1}}`)); err != nil {
		t.Fatal("equal min/default/max was not accepted")
	}
}

func TestComputerResourcesRejectAmbiguousMissingAndUnsafeNumericPolicy(t *testing.T) {
	for _, field := range []string{"cpu", "memoryGB", "diskGB"} {
		for _, member := range []string{"default", "min", "max"} {
			for _, invalid := range []any{nil, true, "8", 0, -1, 1.5, 9_007_199_254_740_992.0} {
				var fixture map[string]map[string]any
				if json.Unmarshal(computerResourceJSON, &fixture) != nil {
					t.Fatal("fixture configuration invalid")
				}
				fixture[field][member] = invalid
				raw, _ := json.Marshal(fixture)
				if _, err := ParseComputerResources(raw); !errors.Is(err, ErrComputerResources) {
					t.Fatalf("unsafe resource %s/%s was accepted", field, member)
				}
			}
		}
	}

	for _, raw := range []string{
		"", "null", "[]", "{}", string(computerResourceJSON) + " {}",
		strings.Repeat(" ", computerResourceMaxBytes) + string(computerResourceJSON),
		strings.Replace(string(computerResourceJSON), `"cpu":`, `"unknown":`, 1),
		strings.Replace(string(computerResourceJSON), `"default":`, `"extra":`, 1),
		strings.Replace(string(computerResourceJSON), `"cpu":`, `"cpu":{},"cpu":`, 1),
		strings.Replace(string(computerResourceJSON), `"default":`, `"default":4,"default":`, 1),
		strings.Replace(string(computerResourceJSON), `"default": 4`, `"default": 65`, 1),
		strings.Replace(string(computerResourceJSON), `"min": 1`, `"min": 65`, 1),
	} {
		if _, err := ParseComputerResources([]byte(raw)); !errors.Is(err, ErrComputerResources) {
			t.Fatal("invalid resource shape or range was accepted")
		}
	}
}

func TestComputerResourcesAcceptEquivalentIntegralJSONNumbers(t *testing.T) {
	for _, literal := range []string{"4.0", "4e0", "4E+0"} {
		raw := strings.Replace(string(computerResourceJSON), `"default": 4`, `"default": `+literal, 1)
		value, err := ParseComputerResources([]byte(raw))
		if err != nil || value.CPU.Default != 4 {
			t.Fatal("integral JSON number spelling changed provisioning policy")
		}
	}
}

func TestComputerResourcesRetainTheCommonProviderInt32Boundary(t *testing.T) {
	for _, literal := range []string{"2147483647", "2147483647.0", "2147483647e0"} {
		raw := []byte(`{"cpu":{"default":` + literal + `,"min":1,"max":` + literal + `},"memoryGB":{"default":8,"min":2,"max":128},"diskGB":{"default":64,"min":32,"max":2048}}`)
		value, err := ParseComputerResources(raw)
		if err != nil || value.CPU.Default != 2_147_483_647 || value.CPU.Max != 2_147_483_647 {
			t.Fatal("exact common provider bound was rejected")
		}
	}
	for _, cpu := range []string{
		`{"default":2147483648,"min":1,"max":2147483648}`,
		`{"default":4,"min":1,"max":2147483648}`,
		`{"default":2147483648,"min":2147483648,"max":2147483648}`,
	} {
		raw := []byte(`{"cpu":` + cpu + `,"memoryGB":{"default":8,"min":2,"max":128},"diskGB":{"default":64,"min":32,"max":2048}}`)
		if _, err := ParseComputerResources(raw); !errors.Is(err, ErrComputerResources) {
			t.Fatal("value beyond the provider integer domain was accepted")
		}
	}
}
