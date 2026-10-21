package i18n

import (
	"bytes"
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
		source := filepath.Join("..", "..", "..", "resources", "i18n", "language-registry.json")
		if raw, err := os.ReadFile(source); err != nil {
			t.Fatal(err)
		} else if embedded, _ := assets.ReadFile("language-registry.json"); !bytes.Equal(raw, embedded) {
			t.Fatal("embedded registry drifted")
		}
		if info.Code != "en" && info.Code != "zh" {
			raw, err := os.ReadFile(filepath.Join("..", "..", "..", "resources", "i18n", "locales", info.Code+".json"))
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

func TestCountFormatsEverySupportedLanguageWithItsGroupingRules(t *testing.T) {
	expected := map[string]string{
		"en": "1,234,567", "zh": "1,234,567", "zh-TW": "1,234,567",
		"ja": "1,234,567", "ko": "1,234,567", "es": "1.234.567",
		"fr": "1\u202f234\u202f567", "de": "1.234.567", "pt": "1.234.567",
		"ru": "1\u00a0234\u00a0567", "ar": "1,234,567", "hi": "12,34,567",
		"id": "1.234.567", "ms": "1,234,567", "it": "1.234.567", "tr": "1.234.567",
	}
	languages, err := Languages()
	if err != nil || len(languages) != len(expected) {
		t.Fatal("number formatting lacks a supported language", err)
	}
	for _, language := range languages {
		t.Run(language.Code, func(t *testing.T) {
			actual, err := Count(language.Code, 1234567, "{count}", "{count}")
			if err != nil || actual != expected[language.Code] {
				t.Fatal("locale grouping or digits changed", err)
			}
			if zero, err := Count(language.Code, 0, "{count}", "{count}"); err != nil || zero != "0" {
				t.Fatal("zero must remain a numeric value", err)
			}
		})
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

func TestScheduleLocalDisplayUsesExplicitTimeZoneAndDayPeriod(t *testing.T) {
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
