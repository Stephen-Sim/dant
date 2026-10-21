package memory

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestQueryPreparationNormalizesUnicodeAndSeparatesRecallTerms(t *testing.T) {
	for _, test := range []struct {
		name, input    string
		search, recall []string
	}{
		{"width-and-operators", "ＡＢＣ \"OR\" 编程语言", []string{"abc", "or", "编程", "程语", "语言"}, []string{"abc", "编程", "程语", "语言"}},
		{"dotted-i", "İ", []string{"i"}, []string{}},
		{"contextual-sigma", "ΟΣ ΟΣΑ Σ", []string{"ος", "οσα", "σ"}, []string{"ος", "οσα", "σ"}},
		{"stopwords", "let had has use compiler", []string{"let", "had", "has", "use", "compiler"}, []string{"had", "has", "compiler"}},
		{"mixed-scripts", "abc中文xyz 日本語aカタカナb", []string{"abc中文xyz", "日本語aカタカナb"}, []string{"abc", "中文", "xyz", "日本", "本語", "カタ", "タカ", "カナ", "b"}},
		{"unicode-space", "\ufeffbom\u0085nel", []string{"bom", "nel"}, []string{"bom", "nel"}},
		{"secret-query", "password=fixture-secret compile", []string{"password", "compile"}, []string{"password", "compile"}},
		{"compatibility-and-supplementary", "𝒜 𐐀 𐐨 ㍿ ᾈ", []string{"a", "𐐨", "株式", "式会", "会社", "ᾀ"}, []string{"𐐨", "株式", "式会", "会社", "ᾀ"}},
		{"deduplicate", "Cobalt cobalt COBALT", []string{"cobalt"}, []string{"cobalt"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			search, err := PrepareSearch(test.input)
			if err != nil || !slices.Equal(search.Terms, test.search) {
				t.Fatalf("search terms differ: %v", err)
			}
			recall, err := PrepareRetrieval(test.input)
			if err != nil || !slices.Equal(recall.Terms, test.recall) {
				t.Fatalf("recall terms differ: %v", err)
			}
		})
	}
}

func TestQueryBoundsUseInputUTF16AndKeepPreparedExpansionSeparate(t *testing.T) {
	for _, input := range []string{strings.Repeat("x", MaxQueryUnits+1), strings.Repeat("😀", MaxQueryUnits/2+1), "before\x00after"} {
		if _, err := PrepareSearch(input); !errors.Is(err, ErrInvalidQuery) {
			t.Fatal("search accepted an oversized or NUL-containing query", err)
		}
	}
	search, err := PrepareSearch(strings.Repeat("ﬃ", 256))
	if err != nil || !slices.Equal(search.Terms, []string{strings.Repeat("ffi", 256)}) {
		t.Fatal("normalization expansion changed the input limit", err)
	}
	recall, err := PrepareRetrieval(strings.Repeat("ﬃ", 256))
	if err != nil || len(recall.Terms) != 0 {
		t.Fatal("recall exceeded its prepared term budget", err)
	}
	recall, err = PrepareRetrieval("before\x00after")
	if err != nil || !slices.Equal(recall.Terms, []string{"before", "after"}) {
		t.Fatal("recall did not separate NUL-delimited words", err)
	}
	search, err = PrepareSearch(strings.Join([]string{"one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen"}, " "))
	if err != nil || len(search.Terms) != MaxTerms || search.Terms[MaxTerms-1] != "sixteen" {
		t.Fatal("term count/order was not bounded", err)
	}
}
