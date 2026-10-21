package i18n

import (
	"encoding/json"
	"testing"
	"testing/fstest"
)

func TestLanguageResourcesRejectIncompleteOrAmbiguousCatalogsWithoutChangingTheCache(t *testing.T) {
	languages, err := Languages()
	if err != nil {
		t.Fatal(err)
	}
	before, err := json.Marshal(languages)
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		name, registry, catalog, code string
	}{
		{"missing registry", "", "", "language_registry_invalid"},
		{"malformed registry", "{", "", "language_registry_invalid"},
		{"empty code", `[{"code":"","direction":"ltr"}]`, "", "language_registry_invalid"},
		{"bad direction", `[{"code":"en","direction":"unknown"}]`, "", "language_registry_invalid"},
		{"duplicate code", `[{"code":"en","direction":"ltr"},{"code":"en","direction":"ltr"}]`, "", "language_registry_invalid"},
		{"missing catalog", `[{"code":"de","direction":"ltr"}]`, "", "language_catalog_invalid"},
		{"malformed catalog", `[{"code":"de","direction":"ltr"}]`, "{", "language_catalog_invalid"},
		{"empty catalog key", `[{"code":"de","direction":"ltr"}]`, `{"":"translated"}`, "language_catalog_invalid"},
		{"empty catalog value", `[{"code":"de","direction":"ltr"}]`, `{"Original":" \n "}`, "language_catalog_invalid"},
		{"valid resources", `[{"code":"en","direction":"ltr"},{"code":"zh","direction":"ltr"},{"code":"de","direction":"ltr"}]`, `{"Original":"Übersetzt"}`, ""},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			source := fstest.MapFS{}
			if fixture.registry != "" {
				source["language-registry.json"] = &fstest.MapFile{Data: []byte(fixture.registry)}
			}
			if fixture.catalog != "" {
				source["locales/de.json"] = &fstest.MapFile{Data: []byte(fixture.catalog)}
			}
			data, err := readLanguages(source)
			if fixture.code == "" {
				if err != nil || len(data.registry) != 3 || data.catalogs["de"]["Original"] != "Übersetzt" {
					t.Fatal("valid resource set lost registry or translation data", err)
				}
			} else if err == nil || err.Error() != fixture.code {
				t.Fatal("invalid resources did not retain their bounded classification", err)
			}
		})
	}
	languages, err = Languages()
	after, marshalErr := json.Marshal(languages)
	if err != nil || marshalErr != nil || string(after) != string(before) {
		t.Fatal("isolated parsing changed the application's embedded resource cache", err, marshalErr)
	}
	for code, catalog := range catalogs {
		for original, translated := range catalog {
			if Translate(code, original) != translated {
				t.Fatal("catalog translation was bypassed", code)
			}
			return
		}
	}
	t.Fatal("embedded resources contained no translated catalogs")
}
