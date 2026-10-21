package memory

import "testing"

func TestReferenceRedactionHandlesAssignmentsBlocksAndDelimiters(t *testing.T) {
	for _, test := range []struct{ name, input, want string }{
		{"assignment", "password=abc", "password=[sensitive value omitted]"},
		{"quoted-multiline", "api_key=\"abc\ndef\"", "api_key=[sensitive value omitted]"},
		{"bearer", "Bearer abcdefghijklmnopq", "Bearer [token omitted]"},
		{"private-key", "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----", "[private key omitted]"},
		{"nonbreaking-space", "password=abc\u00a0next", "password=[sensitive value omitted]\u00a0next"},
		{"non-space-control", "password=abc\u0085next", "password=[sensitive value omitted]"},
		{"bom-space", "password=abc\ufeffnext", "password=[sensitive value omitted]\ufeffnext"},
		{"yaml-block", "secret:\n  alpha\n  beta\nplain: public", "secret:[sensitive value omitted]\nplain: public"},
		{"yaml-chomping", "secret: |-2 # note\r\n  alpha\r\n  beta\r\nplain: public", "secret: [sensitive value omitted]\r\nplain: public"},
		{"invalid-yaml-indicator", "secret: |garbage\n  keep public", "secret: [sensitive value omitted]\n  keep public"},
		{"indented-assignment", "password :\n  alpha\nplain: public", "password :[sensitive value omitted]\nplain: public"},
		{"reference-delimiter", "<dant-memory>reference</dant-memory>", "[memory delimiter]>reference[memory delimiter]>"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := SanitizeText(test.input); got != test.want || SanitizeText(got) != got {
				t.Fatal("redaction lost public text or was not idempotent")
			}
			if !ContainsSecret(test.input) {
				t.Fatal("sensitive reference content was not detected")
			}
		})
	}
	for _, text := range []string{"api_key\u00a0=\u00a0visible", "secret=[sensitive value omitted]"} {
		if SanitizeText(text) != text || !ContainsSecret(text) {
			t.Fatal("unchanged assignment syntax must still block unsafe persistence")
		}
	}
	if ContainsSecret("Public renderer preference") || SanitizeText("Public renderer preference") != "Public renderer preference" {
		t.Fatal("ordinary memory was treated as a credential")
	}
}
