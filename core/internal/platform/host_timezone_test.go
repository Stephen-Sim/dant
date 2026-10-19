package platform

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/i18n"
)

func TestWindowsTimeZonesRetainPinnedSourceProvenance(t *testing.T) {
	var data struct {
		SchemaVersion int               `json:"schemaVersion"`
		GoVersion     string            `json:"goVersion"`
		Source        string            `json:"source"`
		SourceSHA256  string            `json:"sourceSha256"`
		License       string            `json:"license"`
		Copyright     string            `json:"copyright"`
		Zones         map[string]string `json:"zones"`
	}
	if err := json.Unmarshal(windowsTimeZoneJSON, &data); err != nil {
		t.Fatal(err)
	}
	if data.SchemaVersion != 1 || data.GoVersion != "1.27.2" || runtime.Version() != "go"+data.GoVersion || data.License != "BSD-3-Clause" || data.Copyright != "Copyright 2013 The Go Authors. All rights reserved." {
		t.Fatal("timezone data must retain its pinned compiler and source license")
	}
	if data.Source != "https://github.com/golang/go/blob/go1.27.2/src/time/zoneinfo_abbrs_windows.go" {
		t.Fatal("timezone data provenance changed")
	}
	source, err := os.ReadFile(filepath.Join(runtime.GOROOT(), "src", "time", "zoneinfo_abbrs_windows.go"))
	if err != nil {
		t.Fatal("the pinned compiler source is required for drift verification", err)
	}
	normalized := strings.ReplaceAll(string(source), "\r\n", "\n")
	digest := sha256.Sum256([]byte(normalized))
	if hex.EncodeToString(digest[:]) != data.SourceSHA256 {
		t.Fatal("the pinned compiler timezone source changed")
	}
	pattern := regexp.MustCompile(`(?m)^\s*"([^"\n]+)":\s*\{"[^"\n]*",\s*"[^"\n]*"\},\s*// ([A-Za-z0-9_+./-]+)\s*$`)
	rows := pattern.FindAllStringSubmatch(normalized, -1)
	if len(rows) != 139 || len(data.Zones) != len(rows) {
		t.Fatal("timezone mapping dropped or invented source rows")
	}
	for _, row := range rows {
		if data.Zones[row[1]] != row[2] {
			t.Fatal("timezone key no longer matches the pinned CLDR projection")
		}
		if _, ok := i18n.CanonicalTimeZone(row[2]); !ok {
			t.Fatal("a mapped zone is unavailable to the shared runtime validator")
		}
	}
	license, err := os.ReadFile("timezones/GO-LICENSE.txt")
	original, readErr := os.ReadFile(filepath.Join(runtime.GOROOT(), "LICENSE"))
	if err != nil || readErr != nil || string(license) != strings.ReplaceAll(string(original), "\r\n", "\n") {
		t.Fatal("copied timezone data must retain the complete Go license")
	}
}

func TestHostZoneUsesCanonicalIdentityWithoutOffsetsOrDisplayNames(t *testing.T) {
	for key, wanted := range map[string]string{
		"Eastern Standard Time":   "America/New_York",
		"Singapore Standard Time": "Asia/Singapore",
		"India Standard Time":     "Asia/Calcutta",
		"UTC":                     "UTC",
	} {
		actual, err := windowsHostTimeZone(key)
		if err != nil || actual != wanted {
			t.Fatalf("canonical mapping %q: %q %v", key, actual, err)
		}
	}
	for _, invalid := range []string{"", "Local", "EST", "UTC+08:00", "eastern standard time", "Fixture unknown timezone"} {
		if _, err := windowsHostTimeZone(invalid); !errors.Is(err, ErrHostTimeZone) {
			t.Fatal("a missing or localized key became a timezone guess")
		}
	}
	if actual, err := HostTimeZone(map[string]string{"TZ": "asia/kuala_lumpur"}); err != nil || actual != "Asia/Kuala_Lumpur" {
		t.Fatal("captured IANA environment did not retain canonical semantics", actual, err)
	}
	for _, invalid := range []string{"", "Local", "CST8", ":/private/fixture", "Unknown/Fixture"} {
		if _, err := HostTimeZone(map[string]string{"TZ": invalid}); !errors.Is(err, ErrHostTimeZone) {
			t.Fatal("invalid explicit timezone fell through to an unrelated host default")
		}
	}
}

func TestUnixZoneFallbackIsBoundedAndDoesNotInventUTC(t *testing.T) {
	if zone, err := unixHostTimeZone("Europe/Berlin", func() ([]byte, error) {
		t.Fatal("a valid local IANA name must not read another source")
		return nil, nil
	}); err != nil || zone != "Europe/Berlin" {
		t.Fatal("valid local name failed", zone, err)
	}
	for _, value := range []string{"Local", "GMT+8", strings.Repeat("a", hostTimeZoneFileLimit+1), "Asia/Singapore\nEurope/Berlin"} {
		if _, err := unixHostTimeZone("Local", func() ([]byte, error) { return []byte(value), nil }); !errors.Is(err, ErrHostTimeZone) {
			t.Fatal("unconfirmed file data became a host zone")
		}
	}
	if zone, err := unixHostTimeZone("Local", func() ([]byte, error) { return []byte("Asia/Singapore\n"), nil }); err != nil || zone != "Asia/Singapore" {
		t.Fatal("bounded file fallback failed", zone, err)
	}
	if _, err := unixHostTimeZone("Local", func() ([]byte, error) { return nil, os.ErrNotExist }); !errors.Is(err, ErrHostTimeZone) {
		t.Fatal("missing system information invented UTC")
	}
}
