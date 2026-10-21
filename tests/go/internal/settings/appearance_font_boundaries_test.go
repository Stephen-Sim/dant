package settings

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestAppearanceImportsRejectMalformedSchemasAndPreserveOnlyValidatedValues(t *testing.T) {
	for _, raw := range []string{
		`false`, `{"schema":"wrong","version":1,"appearance":{}}`,
		`{"schema":"dant-appearance","version":2,"appearance":{}}`,
		`{"schema":"dant-appearance","version":1,"appearance":null}`,
	} {
		if _, err := ImportAppearance([]byte(raw)); !errors.Is(err, ErrInvalidAppearance) {
			t.Fatal("unsupported appearance schema was accepted", err)
		}
	}
	for _, raw := range []string{`{"theme":false}`, `{"fontFamily":null}`, `{"fontFamily":false}`, `{"fontFamily":"` + strings.Repeat("😀", 65) + `"}`} {
		if _, err := ValidateAppearancePatch(json.RawMessage(raw)); !errors.Is(err, ErrInvalidAppearance) {
			t.Fatal("invalid authored appearance was accepted", err)
		}
	}
	if _, err := appearanceValue("unsupported", json.RawMessage(`true`)); !errors.Is(err, ErrInvalidAppearance) {
		t.Fatal("unknown appearance field acquired validation semantics")
	}
	if defaults := ReadAppearance(json.RawMessage(`null`)); defaults != AppearanceDefaults() {
		t.Fatal("invalid saved appearance displaced safe defaults")
	}
	patch, err := ValidateAppearancePatch(json.RawMessage(`{"backgroundColor":null,"foregroundColor":"#abcDEF","fontFamily":"  Fixture Font  "}`))
	if err != nil || string(patch["backgroundColor"]) != "null" || string(patch["foregroundColor"]) != `"#ABCDEF"` || string(patch["fontFamily"]) != `"Fixture Font"` {
		t.Fatal("validated optional colors or captured font family changed", err)
	}
}

func TestFontInventoryBoundariesRejectOversizedFailedAndUnstructuredProcessOutput(t *testing.T) {
	for _, mode := range []string{"failed", "bytes", "entries", "null", "object"} {
		t.Run(mode, func(t *testing.T) {
			result, err := ListSystemFonts(t.Context(), FontOptions{Platform: "windows", Run: func(ctx context.Context, args []string) ([]byte, error) {
				if _, present := ctx.Deadline(); !present || len(args) < 2 {
					t.Fatal("font process did not receive a bounded owner")
				}
				switch mode {
				case "failed":
					return nil, errors.New("synthetic font process failure")
				case "bytes":
					return make([]byte, maxFontInventoryBytes+1), nil
				case "entries":
					return []byte("[" + strings.Repeat(`"fixture",`, maxFontInventoryEntries) + `"fixture"]`), nil
				case "null":
					return []byte("null"), nil
				default:
					return []byte("{}"), nil
				}
			}})
			if !errors.Is(err, ErrFontsUnavailable) || len(result.Fonts) != 0 || result.Source != "fallback" {
				t.Fatal("failed inventory advertised system fonts", err)
			}
		})
	}
	output := &limitedFontOutput{}
	if count, err := output.Write([]byte("fixture")); err != nil || count != 7 {
		t.Fatal("bounded font output lost bytes", count, err)
	}
	if count, err := output.Write(make([]byte, maxFontInventoryBytes)); count != 0 || !errors.Is(err, ErrFontsUnavailable) || output.data.String() != "fixture" {
		t.Fatal("oversized font output retained a partial write")
	}
	// This path resolves the platform command, but cancellation occurs before
	// starting it. No installed font inventory or user process is queried.
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := ListSystemFonts(ctx, FontOptions{Platform: "windows"}); !errors.Is(err, ErrFontsUnavailable) {
		t.Fatal("cancelled native font process was accepted", err)
	}
	if _, err := ListSystemFonts(t.Context(), FontOptions{Run: func(context.Context, []string) ([]byte, error) { return []byte(`[]`), nil }}); err != nil {
		t.Fatal("native platform selection failed", err)
	}
}

func TestUsageOrderingRejectsMalformedReceiptsAndPreservesOnlyCurrentDistinctIdentities(t *testing.T) {
	for _, raw := range []string{"null", `{"a":`, `{"a":1,]`} {
		if keys := orderedKeys(json.RawMessage(raw)); keys != nil {
			t.Fatal("malformed receipt supplied an insertion order")
		}
	}
	keys := recordKeys([]string{"old", "b", "b"}, map[string]int{"a": 1, "b": 2})
	if len(keys) != 2 || keys[0] != "b" || keys[1] != "a" {
		t.Fatal("stale or duplicated receipt identity changed stable ordering")
	}
	if _, err := orderedRecords([]string{"invalid"}, map[string]json.RawMessage{"invalid": json.RawMessage(`{`)}); err == nil {
		t.Fatal("unmarshalable ordered value was reported as saved")
	}
}
