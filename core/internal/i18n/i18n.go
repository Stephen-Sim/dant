// Package i18n embeds fixed system copy; it never translates user content.
package i18n

import (
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"strings"
	"sync"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

//go:embed language-registry.json locales/*.json
var assets embed.FS

type Language struct {
	Code      string `json:"code"`
	Label     string `json:"label"`
	Name      string `json:"name"`
	Locale    string `json:"locale"`
	Speech    string `json:"speech"`
	Direction string `json:"direction"`
}

var once sync.Once
var registry []Language
var byCode map[string]Language
var catalogs map[string]map[string]string
var loadError error

func initialize() {
	data, err := readLanguages(assets)
	registry, byCode, catalogs, loadError = data.registry, data.byCode, data.catalogs, err
}

type languageData struct {
	registry []Language
	byCode   map[string]Language
	catalogs map[string]map[string]string
}

// readLanguages validates one complete embedded resource set. Keeping parsing
// separate from the once-owned cache avoids mutable global test fixtures.
func readLanguages(source fs.ReadFileFS) (languageData, error) {
	data := languageData{byCode: map[string]Language{}, catalogs: map[string]map[string]string{}}
	raw, err := source.ReadFile("language-registry.json")
	if err != nil || json.Unmarshal(raw, &data.registry) != nil {
		return data, errors.New("language_registry_invalid")
	}
	for _, info := range data.registry {
		if info.Code == "" || info.Direction != "ltr" && info.Direction != "rtl" {
			return data, errors.New("language_registry_invalid")
		}
		if _, exists := data.byCode[info.Code]; exists {
			return data, errors.New("language_registry_invalid")
		}
		data.byCode[info.Code] = info
		if info.Code == "en" || info.Code == "zh" {
			continue
		}
		raw, err := source.ReadFile("locales/" + info.Code + ".json")
		var catalog map[string]string
		if err != nil || json.Unmarshal(raw, &catalog) != nil {
			return data, errors.New("language_catalog_invalid")
		}
		for key, value := range catalog {
			if key == "" || contracts.TrimText(value) == "" {
				return data, errors.New("language_catalog_invalid")
			}
		}
		data.catalogs[info.Code] = catalog
	}
	return data, nil
}

func Languages() ([]Language, error) {
	once.Do(initialize)
	return append([]Language{}, registry...), loadError
}

func IsLanguage(code string) bool {
	once.Do(initialize)
	_, ok := byCode[code]
	return loadError == nil && ok
}

func Normalize(code, fallback string) string {
	if IsLanguage(code) {
		return code
	}
	if IsLanguage(fallback) {
		return fallback
	}
	return "zh"
}

func Info(code string) Language {
	once.Do(initialize)
	return byCode[Normalize(code, "zh")]
}
func IsChinese(code string) bool { return code == "zh" || code == "zh-TW" }
func ForWorker(code string, supported []string) string {
	selected := Normalize(code, "zh")
	for _, item := range supported {
		if item == selected {
			return selected
		}
	}
	if IsChinese(selected) {
		return "zh"
	}
	return "en"
}

func Translate(code, english string, chinese ...string) string {
	selected := Normalize(code, "en")
	if selected == "zh" && len(chinese) > 0 {
		return chinese[0]
	}
	once.Do(initialize)
	if translated, ok := catalogs[selected][english]; ok {
		return translated
	}
	return english
}

func Count(code string, count int64, singular, plural string, chinese ...string) (string, error) {
	if count < 0 || count > 9007199254740991 {
		return "", errors.New("language_count_invalid")
	}
	template := plural
	if count == 1 {
		template = singular
	}
	selected := Normalize(code, "en")
	translated := Translate(selected, template, chinese...)
	return strings.ReplaceAll(translated, "{count}", formatCount(selected, count)), nil
}
