package i18n

import (
	"strings"
	"testing"
	"time"
)

func TestLanguageFallbackCountSingularAndCustomZoneOffsetsRetainTheirContracts(t *testing.T) {
	if Normalize("unknown", "unknown") != "zh" || Normalize("unknown", "en") != "en" || ForWorker("ja", []string{"ja"}) != "ja" {
		t.Fatal("unknown language fallback or supported worker code changed")
	}
	if text, err := Count("en", 1, "{count} item", "{count} items"); err != nil || text != "1 item" {
		t.Fatal("singular fixed template lost its count", err)
	}
	if _, err := Count("en", 9007199254740992, "{count}", "{count}"); err == nil {
		t.Fatal("unsafe count precision was accepted")
	}
	if _, ok := CanonicalTimeZone(strings.Repeat("x", 101)); ok {
		t.Fatal("unbounded timezone identity was accepted")
	}
	for _, fixture := range []struct {
		offset int
		label  string
	}{
		{0, "GMT"}, {-(3*3600 + 30*60 + 15), "GMT-3:30:15"}, {5*3600 + 45*60, "GMT+5:45"},
	} {
		if text := ScheduleLocalTime(1760000000000, time.FixedZone("Synthetic/Offset", fixture.offset)); !strings.HasSuffix(text, " "+fixture.label) {
			t.Fatal("custom timezone offset changed", text)
		}
	}
}
