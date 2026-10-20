package files

import (
	"strings"
	"testing"
)

func TestRecoveryMarkdownMatchesStoredMarkedDestinations(t *testing.T) {
	// Expected Markdown destinations follow marked's parsing rules. HTML entities
	// remain part of token.href; punctuation escapes do not.
	cases := []struct {
		name, source, href string
		allowed            bool
	}{
		{"link", "[file](output/result.png)", "output/result.png", true},
		{"image", "![file](output/result.png)", "output/result.png", true},
		{"reference", "[file][saved]\n\n[saved]: output/result.png", "output/result.png", true},
		{"collapsed reference", "[saved][]\n\n[saved]: output/result.png", "output/result.png", true},
		{"space rendered", "[file](<output/a b.png>)", "output/a%20b.png", true},
		{"escaped punctuation", `[file](output/a\(b\).png)`, "output/a(b).png", true},
		{"entity token", "[file](output/a&amp;b.png)", "output/a&amp;b.png", true},
		{"entity rendered mismatch", "[file](output/a&amp;b.png)", "output/a&b.png", false},
		{"unicode rendered", "[file](output/截图.png)", "output/%E6%88%AA%E5%9B%BE.png", true},
		{"percent once", "[file](output/100%2520.png)", "output/100%2520.png", true},
		{"autolink", "<file:///tmp/output/a.png>", "file:///tmp/output/a.png", true},
		{"inline code", "`[file](output/result.png)`", "output/result.png", false},
		{"code fence", "```md\n[file](output/result.png)\n```", "output/result.png", false},
		{"raw html", `<a href="output/result.png">file</a>`, "output/result.png", false},
		{"escaped link", `\[file](output/result.png)`, "output/result.png", false},
		{"different target", "[file](output/result.png)", "output/other.png", false},
		{"bounded UTF16", strings.Repeat("😀", MaxRecoveryMessageUnits/2) + "[file](output/result.png)", "output/result.png", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := recoveryStoredLink(test.source, test.href); got != test.allowed {
				t.Fatalf("stored destination match = %v, want %v", got, test.allowed)
			}
		})
	}
}
