package config

import (
	_ "embed"
	"encoding/json"
	"errors"
	"math"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	ComputerResourcePath     = "resources/config/computer.json"
	computerResourceMaxBytes = 4 * 1024
	computerResourceMaxValue = 2_147_483_647
)

var ErrComputerResources = errors.New("invalid_computer_resources")

//go:embed assets/computer.json
var computerResourceJSON []byte

type ResourceRange struct {
	Default int `json:"default"`
	Min     int `json:"min"`
	Max     int `json:"max"`
}

func (value ResourceRange) Contains(candidate int) bool {
	return candidate >= value.Min && candidate <= value.Max
}

type ComputerResources struct {
	CPU      ResourceRange `json:"cpu"`
	MemoryGB ResourceRange `json:"memoryGB"`
	DiskGB   ResourceRange `json:"diskGB"`
}

func ParseComputerResources(raw []byte) (ComputerResources, error) {
	object, err := contracts.DecodeObject(raw, computerResourceMaxBytes)
	if err != nil || len(object) != 3 {
		return ComputerResources{}, ErrComputerResources
	}

	var result ComputerResources
	for _, field := range []struct {
		name  string
		value *ResourceRange
	}{
		{"cpu", &result.CPU},
		{"memoryGB", &result.MemoryGB},
		{"diskGB", &result.DiskGB},
	} {
		members, err := contracts.DecodeObject(object[field.name], computerResourceMaxBytes)
		if err != nil || len(members) != 3 {
			return ComputerResources{}, ErrComputerResources
		}

		for _, member := range []struct {
			name  string
			value *int
		}{
			{"default", &field.value.Default},
			{"min", &field.value.Min},
			{"max", &field.value.Max},
		} {
			var value float64
			if json.Unmarshal(members[member.name], &value) != nil || value < 1 || value > computerResourceMaxValue || math.Trunc(value) != value {
				return ComputerResources{}, ErrComputerResources
			}
			*member.value = int(value)
		}
		if !field.value.Contains(field.value.Default) {
			return ComputerResources{}, ErrComputerResources
		}
	}

	return result, nil
}

var defaultComputerResources = func() ComputerResources {
	value, err := ParseComputerResources(computerResourceJSON)
	if err != nil {
		panic("invalid embedded computer resources")
	}
	return value
}()

// DefaultComputerResources returns the generated resource by value. It is a
// provisioning policy, independent of environment options and existing VMs.
func DefaultComputerResources() ComputerResources {
	return defaultComputerResources
}
