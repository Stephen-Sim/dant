package memory

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestNodeNormalizationAndRedactionGoldenContract(t *testing.T) {
	data, err := os.ReadFile("testdata/node-memory-goldens.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Node, Unicode string
		Queries       []struct {
			Input            string
			Search, Retrieve []string
		}
		Safety []struct {
			Input, Safe string
			Secret      bool
		}
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Node != "22.23.3" || fixture.Unicode != "17.0" {
		t.Fatal("unrecognized reference runtime")
	}
	for index, test := range fixture.Queries {
		actual, err := PrepareSearch(test.Input)
		if test.Search == nil {
			if err == nil {
				t.Fatalf("search %d accepted invalid input", index)
			}
		} else if err != nil || !reflect.DeepEqual(actual.Terms, test.Search) {
			t.Fatalf("search %d differs: %v", index, err)
		}
		actual, err = PrepareRetrieval(test.Input)
		if err != nil || !reflect.DeepEqual(actual.Terms, test.Retrieve) {
			t.Fatalf("retrieval %d differs: %v", index, err)
		}
	}
	for index, test := range fixture.Safety {
		if SanitizeText(test.Input) != test.Safe || ContainsSecret(test.Input) != test.Secret {
			t.Fatalf("redaction %d differs from Node", index)
		}
	}
}
