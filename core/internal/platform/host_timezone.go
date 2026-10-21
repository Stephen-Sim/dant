package platform

import (
	_ "embed"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"github.com/Stephen-Sim/dant/core/internal/i18n"
)

var ErrHostTimeZone = errors.New("host_time_zone_unavailable")

const hostTimeZoneFileLimit = 1024

//go:embed timezones/windows-timezones.json
var windowsTimeZoneJSON []byte

var windowsTimeZones struct {
	sync.Once
	zones map[string]string
}

// HostTimeZone returns a canonical IANA identity, never an offset-derived guess.
// Environment belongs to the startup configuration snapshot, not ambient reads.
func HostTimeZone(environment map[string]string) (string, error) {
	if value, present := environment["TZ"]; present {
		return canonicalHostTimeZone(value)
	}

	return systemHostTimeZone()
}

func canonicalHostTimeZone(value string) (string, error) {
	if name, ok := i18n.CanonicalTimeZone(value); ok {
		return name, nil
	}
	return "", ErrHostTimeZone
}

func windowsHostTimeZone(key string) (string, error) {
	windowsTimeZones.Do(func() {
		var data struct {
			Zones map[string]string `json:"zones"`
		}
		if json.Unmarshal(windowsTimeZoneJSON, &data) == nil {
			windowsTimeZones.zones = data.Zones
		}
	})

	value, exists := windowsTimeZones.zones[key]
	if !exists {
		return "", ErrHostTimeZone
	}
	return canonicalHostTimeZone(value)
}

func unixHostTimeZone(local string, readFile func() ([]byte, error)) (string, error) {
	if name, err := canonicalHostTimeZone(local); err == nil {
		return name, nil
	}
	data, err := readFile()
	if err != nil || len(data) > hostTimeZoneFileLimit {
		return "", ErrHostTimeZone
	}

	return canonicalHostTimeZone(strings.TrimSpace(string(data)))
}
