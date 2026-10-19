package i18n

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAllSixteenLanguagesAreEmbeddedAndKeepStableWireCodes(t *testing.T) {
	languages, err := Languages()
	if err != nil || len(languages) != 16 {
		t.Fatal("language coverage changed", err)
	}
	for _, info := range languages {
		if !IsLanguage(info.Code) || Normalize(info.Code, "en") != info.Code || Info(info.Code) != info {
			t.Fatal("registry lost exact language")
		}
		source := filepath.Join("..", "..", "..", "src", "i18n", "language-registry.json")
		if raw, err := os.ReadFile(source); err != nil {
			t.Fatal(err)
		} else if embedded, _ := assets.ReadFile("language-registry.json"); !bytes.Equal(raw, embedded) {
			t.Fatal("embedded registry drifted")
		}
		if info.Code != "en" && info.Code != "zh" {
			raw, err := os.ReadFile(filepath.Join("..", "..", "..", "src", "i18n", "locales", info.Code+".json"))
			embedded, embedErr := assets.ReadFile("locales/" + info.Code + ".json")
			if err != nil || embedErr != nil || !bytes.Equal(raw, embedded) {
				t.Fatal("embedded catalog drifted")
			}
		}
	}
	if !IsChinese("zh-TW") || ForWorker("ja", []string{"en", "zh"}) != "en" || ForWorker("zh-TW", []string{"en", "zh"}) != "zh" {
		t.Fatal("legacy worker fallback changed")
	}
}

func TestNodeIntlCountGoldenAllLanguages(t *testing.T) {
	raw, err := os.ReadFile("node-count-goldens.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Code, Value string }
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, test := range cases {
		actual, err := Count(test.Code, 1234567, "{count}", "{count}")
		if err != nil || actual != test.Value {
			t.Fatalf("locale %s count differs: %q", test.Code, actual)
		}
	}
}

func TestTimeZoneAliasesCaseAndRejectedLocalContract(t *testing.T) {
	for input, want := range map[string]string{"US/Eastern": "America/New_York", "asia/kuala_lumpur": "Asia/Kuala_Lumpur", "Etc/UTC": "UTC", "EST": "America/Panama"} {
		if got, ok := CanonicalTimeZone(input); !ok || got != want {
			t.Fatalf("timezone %s: %s", input, got)
		}
	}
	for _, input := range []string{"Local", "", " UTC", "../UTC", "Invalid/zone"} {
		if _, ok := CanonicalTimeZone(input); ok {
			t.Fatalf("invalid timezone accepted")
		}
	}
}

func TestScheduleLocalDisplayMatchesNodeEnCAContract(t *testing.T) {
	for zone, want := range map[string]string{"UTC": "Oct 9, 2025, 8:53:20 a.m. UTC", "Asia/Kuala_Lumpur": "Oct 9, 2025, 4:53:20 p.m. GMT+8", "America/New_York": "Oct 9, 2025, 4:53:20 a.m. EDT", "Europe/Berlin": "Oct 9, 2025, 10:53:20 a.m. GMT+2", "Australia/Lord_Howe": "Oct 9, 2025, 7:53:20 p.m. GMT+11"} {
		location, err := time.LoadLocation(zone)
		if err != nil || ScheduleLocalTime(1760000000000, location) != want {
			t.Fatalf("local display differs: %s", zone)
		}
	}
}

func TestOnlyFixedTemplatesAreTranslatedWithEnglishFallback(t *testing.T) {
	if Translate("zh", "Hello", "你好") != "你好" || Translate("en", "Hello", "你好") != "Hello" || Translate("ja", "not-a-fixed-catalog-key") != "not-a-fixed-catalog-key" {
		t.Fatal("translation fallback changed")
	}
	count, err := Count("en", 1234, "{count} item", "{count} items")
	if err != nil || count != "1,234 items" {
		t.Fatal(count, err)
	}
	if _, err = Count("en", -1, "{count}", "{count}"); err == nil {
		t.Fatal("invalid count accepted")
	}
}
