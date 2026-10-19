package i18n

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata"
)

// Canonical names retain the Node 22 Intl wire contract, including legacy IANA
// aliases and ASCII case-insensitive identifiers. These are fixed data, not
// user-editable schedule policy.
//
//go:embed timezones.json
var timeZoneJSON []byte

var timeZoneOnce sync.Once
var timeZoneNames map[string]string

//go:embed timezone-display.json
var timeZoneDisplayJSON []byte
var timeZoneDisplays map[string]map[string]string

func CanonicalTimeZone(value string) (string, bool) {
	if value == "" || len(value) > 100 {
		return "", false
	}
	timeZoneOnce.Do(func() {
		_ = json.Unmarshal(timeZoneJSON, &timeZoneNames)
		_ = json.Unmarshal(timeZoneDisplayJSON, &timeZoneDisplays)
	})
	name, ok := timeZoneNames[strings.ToLower(value)]
	if !ok {
		return "", false
	}
	if _, err := time.LoadLocation(name); err != nil {
		return "", false
	}
	return name, true
}

func ScheduleLocalTime(at int64, location *time.Location) string {
	CanonicalTimeZone(location.String())
	value := time.UnixMilli(at).In(location)
	_, offset := value.Zone()
	label := timeZoneDisplays[location.String()][strconv.Itoa(offset)]
	if label == "" {
		if offset == 0 {
			label = "GMT"
		} else {
			sign := "+"
			if offset < 0 {
				offset = -offset
				sign = "-"
			}
			label = "GMT" + sign + strconv.Itoa(offset/3600)
			if offset%3600 != 0 {
				label += fmt.Sprintf(":%02d", offset/60%60)
			}
			if offset%60 != 0 {
				label += fmt.Sprintf(":%02d", offset%60)
			}
		}
	}
	hour := value.Hour() % 12
	if hour == 0 {
		hour = 12
	}
	period := "a.m."
	if value.Hour() >= 12 {
		period = "p.m."
	}
	return fmt.Sprintf("%s %d, %d, %d:%02d:%02d %s %s", value.Format("Jan"), value.Day(), value.Year(), hour, value.Minute(), value.Second(), period, label)
}
