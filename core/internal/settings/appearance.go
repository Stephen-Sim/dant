package settings

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

var ErrInvalidAppearance = errors.New("appearance_invalid")

type Appearance struct {
	Theme           string  `json:"theme"`
	ThemePreset     string  `json:"themePreset"`
	AccentColor     *string `json:"accentColor"`
	BackgroundColor *string `json:"backgroundColor"`
	ForegroundColor *string `json:"foregroundColor"`
	Font            string  `json:"font"`
	FontFamily      string  `json:"fontFamily"`
	FontSize        int     `json:"fontSize"`
	ContentFontSize int     `json:"contentFontSize"`
	CodeFontSize    int     `json:"codeFontSize"`
	ReduceMotion    string  `json:"reduceMotion"`
}

func AppearanceDefaults() Appearance {
	return Appearance{
		Theme: "system", ThemePreset: "chatgpt",
		Font: "system", FontFamily: "",
		FontSize:        13,
		ContentFontSize: 14,
		CodeFontSize:    13,
		ReduceMotion:    "system",
	}
}

var appearanceChoices = map[string][]string{
	"theme":        {"system", "light", "dark"},
	"themePreset":  {"dant", "chatgpt", "warm", "custom"},
	"font":         {"system", "sans", "mono"},
	"reduceMotion": {"system", "reduce", "full"},
}
var appearanceRanges = map[string][2]int{"fontSize": {12, 18}, "contentFontSize": {12, 24}, "codeFontSize": {11, 22}}
var colorPattern = regexp.MustCompile(`(?i)^#[0-9a-f]{6}$`)
var unsafeFont = regexp.MustCompile(`[\x00-\x1f\x7f;{}"'\\]`)
var appearanceFields = []string{"theme", "themePreset", "accentColor", "backgroundColor", "foregroundColor", "font", "fontFamily", "fontSize", "contentFontSize", "codeFontSize", "reduceMotion"}

func appearanceValue(key string, raw json.RawMessage) (json.RawMessage, error) {
	if choices, ok := appearanceChoices[key]; ok {
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return nil, ErrInvalidAppearance
		}
		for _, choice := range choices {
			if value == choice {
				return json.Marshal(value)
			}
		}
		return nil, ErrInvalidAppearance
	}
	if bounds, ok := appearanceRanges[key]; ok {
		var value float64
		if json.Unmarshal(raw, &value) != nil || value != float64(int(value)) || value < float64(bounds[0]) || value > float64(bounds[1]) {
			return nil, ErrInvalidAppearance
		}
		return json.Marshal(int(value))
	}
	if strings.HasSuffix(key, "Color") {
		if strings.TrimSpace(string(raw)) == "null" {
			return json.RawMessage("null"), nil
		}
		var value string
		if json.Unmarshal(raw, &value) != nil || !colorPattern.MatchString(value) {
			return nil, ErrInvalidAppearance
		}
		return json.Marshal(strings.ToUpper(value))
	}
	if key == "fontFamily" {
		if strings.TrimSpace(string(raw)) == "null" {
			return nil, ErrInvalidAppearance
		}
		var value string
		if json.Unmarshal(raw, &value) != nil || len(utf16.Encode([]rune(value))) > 128 || unsafeFont.MatchString(value) {
			return nil, ErrInvalidAppearance
		}
		return json.Marshal(contracts.TrimText(value))
	}
	return nil, ErrInvalidAppearance
}

func ValidateAppearancePatch(raw json.RawMessage) (contracts.RawObject, error) {
	object, err := contracts.DecodeObject(raw, 64*1024)
	if err != nil {
		return nil, ErrInvalidAppearance
	}
	result := contracts.RawObject{}
	for _, key := range appearanceFields {
		if value, ok := object[key]; ok {
			normalized, err := appearanceValue(key, value)
			if err != nil {
				return nil, err
			}
			result[key] = normalized
		}
	}
	return result, nil
}

func ReadAppearance(raw json.RawMessage) Appearance {
	defaults := AppearanceDefaults()
	object, err := contracts.DecodeObject(raw, 64*1024)
	if err != nil {
		return defaults
	}
	data, _ := json.Marshal(defaults)
	var fields contracts.RawObject
	_ = json.Unmarshal(data, &fields)
	for _, key := range appearanceFields {
		if value, ok := object[key]; ok {
			if normalized, err := appearanceValue(key, value); err == nil {
				fields[key] = normalized
			}
		}
	}
	data, _ = json.Marshal(fields)
	_ = json.Unmarshal(data, &defaults)
	return defaults
}

func ExportAppearance(raw json.RawMessage) ([]byte, error) {
	return json.MarshalIndent(struct {
		Schema     string     `json:"schema"`
		Version    int        `json:"version"`
		Appearance Appearance `json:"appearance"`
	}{"dant-appearance", 1, ReadAppearance(raw)}, "", "  ")
}

func ImportAppearance(raw []byte) (contracts.RawObject, error) {
	object, err := contracts.DecodeObject(raw, 64*1024)
	if err != nil || len(object) != 3 {
		return nil, ErrInvalidAppearance
	}
	var schema string
	var version int
	if json.Unmarshal(object["schema"], &schema) != nil || schema != "dant-appearance" || json.Unmarshal(object["version"], &version) != nil || version != 1 {
		return nil, ErrInvalidAppearance
	}
	fields, err := contracts.DecodeObject(object["appearance"], 64*1024)
	if err != nil {
		return nil, ErrInvalidAppearance
	}
	allowed := map[string]bool{}
	for _, key := range appearanceFields {
		allowed[key] = true
	}
	for key := range fields {
		if !allowed[key] {
			return nil, ErrInvalidAppearance
		}
	}
	return ValidateAppearancePatch(object["appearance"])
}
