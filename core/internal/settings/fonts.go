package settings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

const fontInventoryTimeout = 15 * time.Second
const maxFontInventoryBytes = 256 * 1024
const maxFontInventoryEntries = 2048
const fontScript = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName PresentationCore
$dantFontNames = @([System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source } | Sort-Object -Unique)
ConvertTo-Json -InputObject $dantFontNames -Compress`

var ErrFontsUnavailable = errors.New("font_inventory_unavailable")

type FontInventory struct {
	Fonts  []string `json:"fonts"`
	Source string   `json:"source"`
}

type FontRunner func(context.Context, []string) ([]byte, error)
type FontOptions struct {
	Platform string
	Run      FontRunner
}

func ListSystemFonts(ctx context.Context, options FontOptions) (FontInventory, error) {
	platform := options.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	result := FontInventory{Fonts: []string{}, Source: "fallback"}
	if platform != "windows" && platform != "win32" {
		return result, nil
	}
	run := options.Run
	if run == nil {
		run = runFontInventory
	}
	bounded, cancel := context.WithTimeout(ctx, fontInventoryTimeout)
	defer cancel()
	raw, err := run(bounded, []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", fontScript})
	if err != nil || len(raw) > maxFontInventoryBytes {
		return result, ErrFontsUnavailable
	}
	var values []json.RawMessage
	if json.Unmarshal(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}), &values) != nil || values == nil || len(values) > maxFontInventoryEntries {
		return result, ErrFontsUnavailable
	}
	seen := map[string]bool{}
	for _, raw := range values {
		var value string
		if json.Unmarshal(raw, &value) != nil || string(raw) == "null" || contracts.UTF16Length(value) > 128 || unsafeFont.MatchString(value) {
			continue
		}
		value = contracts.TrimText(value)
		if value != "" && !seen[value] {
			seen[value] = true
			result.Fonts = append(result.Fonts, value)
		}
	}
	collator := collate.New(language.English)
	sort.SliceStable(result.Fonts, func(a, b int) bool { return collator.CompareString(result.Fonts[a], result.Fonts[b]) < 0 })
	result.Source = "windows"
	return result, nil
}

type limitedFontOutput struct{ data bytes.Buffer }

func (out *limitedFontOutput) Write(data []byte) (int, error) {
	if out.data.Len()+len(data) > maxFontInventoryBytes {
		return 0, ErrFontsUnavailable
	}
	return out.data.Write(data)
}

func runFontInventory(ctx context.Context, args []string) ([]byte, error) {
	program, err := fontPowerShell()
	if err != nil {
		return nil, ErrFontsUnavailable
	}
	command := exec.CommandContext(ctx, program, args...)
	command.WaitDelay = time.Second
	hideFontCommand(command)
	var output limitedFontOutput
	command.Stdout = &output
	command.Stderr = io.Discard
	if err = command.Run(); err != nil {
		return nil, ErrFontsUnavailable
	}
	return []byte(strings.TrimPrefix(output.data.String(), "\ufeff")), nil
}
