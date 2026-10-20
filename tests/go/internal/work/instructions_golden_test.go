package work

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type workPromptGolden struct {
	Node         string            `json:"node"`
	SourceCommit string            `json:"sourceCommit"`
	OracleSource string            `json:"oracleSource"`
	OracleSHA256 string            `json:"oracleSha256"`
	DynamicTools []json.RawMessage `json:"dynamicTools"`
	Instructions string            `json:"instructions"`
}

func readWorkPromptGolden(t *testing.T) workPromptGolden {
	t.Helper()
	file := filepath.Join("..", "..", "..", "tests", "support", "goldens", "work-prompt-node22.json")
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}

	// This is the original independent Node capture, not regenerated Go output.
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != "cebd0dfe80b5e0d7e724c3aa08e1af13b06d0bbf437a38bb857a300637c005e9" {
		t.Fatal("independent Node prompt fixture bytes changed")
	}
	var golden workPromptGolden
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	if golden.Node != "22.23.3" || golden.SourceCommit != "d058bdc7509efce90bd9d96cc367b04e11c98bae" ||
		golden.OracleSource != "src/work/engine.mts" ||
		golden.OracleSHA256 != "b5ce51b65ef54731bad9c51e905a7eade526ff568af367975f991a56a43e7117" ||
		len(golden.DynamicTools) != 19 || golden.Instructions == "" {
		t.Fatal("independent Node prompt fixture provenance or shape is invalid")
	}
	return golden
}

func decodeWorkPromptJSON(t *testing.T, raw []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatal(err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		t.Fatal("prompt declaration contains trailing JSON")
	}
	return value
}

func TestToolDeclarationsMatchIndependentNode22GoldenExactly(t *testing.T) {
	golden := readWorkPromptGolden(t)
	tools := DynamicTools()
	if len(tools) != len(golden.DynamicTools) {
		t.Fatal("tool declaration count differs from the independent Node capture")
	}
	for index, expected := range golden.DynamicTools {
		// Maps ignore JSON property formatting/order; slices preserve tool/schema
		// array order, and UseNumber keeps numbers distinct from quoted strings.
		actual := decodeWorkPromptJSON(t, tools[index])
		want := decodeWorkPromptJSON(t, expected)
		if !reflect.DeepEqual(actual, want) {
			t.Fatalf("tool declaration %d differs from the independent Node capture", index)
		}
	}
}

func TestInstructionTemplateMatchesIndependentNode22GoldenBytes(t *testing.T) {
	golden := readWorkPromptGolden(t)
	if !bytes.Equal([]byte(instructionsTemplate), []byte(golden.Instructions)) {
		t.Fatal("instruction template bytes differ from the independent Node capture")
	}
}
