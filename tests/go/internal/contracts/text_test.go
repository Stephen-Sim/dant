package contracts

import "testing"

func TestTextKeepsJavaScriptWhitespaceAndUTF16Semantics(t *testing.T) {
	if TrimText("\ufeff\u3000value\u2028\ufeff") != "value" {
		t.Fatal("ECMAScript whitespace not trimmed")
	}
	if TrimText("\u0085value\u0085") != "\u0085value\u0085" {
		t.Fatal("non-ECMAScript whitespace changed")
	}
	if UTF16Length("中文🐱x") != 5 {
		t.Fatal("UTF-16 string length changed")
	}
}
