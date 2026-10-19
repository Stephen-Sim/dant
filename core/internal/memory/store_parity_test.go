package memory

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestNodeWriterGoldenLifecycle(t *testing.T) {
	raw, err := os.ReadFile("testdata/node-writer-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Node  string
		IDs   []string
		Steps []struct {
			Method        string
			Input, Output json.RawMessage
			At            int64
			Error         bool
		}
	}
	if err = json.Unmarshal(raw, &fixture); err != nil || fixture.Node != "22.23.3" {
		t.Fatal("invalid fixture")
	}
	ctx := context.Background()
	now := int64(0)
	idIndex := 0
	s, err := OpenStore(ctx, t.TempDir(), StoreOptions{Now: func() time.Time { return time.UnixMilli(now) }, NewID: func() string {
		if idIndex >= len(fixture.IDs) {
			t.Fatal("unexpected new record")
		}
		id := fixture.IDs[idIndex]
		idIndex++
		return id
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for index, step := range fixture.Steps {
		now = step.At
		var actual any
		switch step.Method {
		case "propose":
			var value Proposal
			err = json.Unmarshal(step.Input, &value)
			if err == nil {
				actual, err = s.Propose(ctx, value)
			}
		case "confirm":
			var value struct {
				ID      string
				Resolve bool
			}
			err = json.Unmarshal(step.Input, &value)
			if err == nil {
				actual, err = s.Confirm(ctx, value.ID, value.Resolve)
			}
		case "update":
			var value struct {
				ID    string
				Patch EntryPatch
			}
			err = json.Unmarshal(step.Input, &value)
			if err == nil {
				actual, err = s.Update(ctx, value.ID, value.Patch)
			}
		case "list":
			actual, err = s.Entries(ctx, "")
		default:
			t.Fatal("unknown fixture method")
		}
		if (err != nil) != step.Error {
			t.Fatalf("step %d error parity differs: %v", index, err)
		}
		if step.Error {
			continue
		}
		encoded, err := json.Marshal(actual)
		if err != nil {
			t.Fatal(err)
		}
		var got, want any
		if json.Unmarshal(encoded, &got) != nil || json.Unmarshal(step.Output, &want) != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("step %d %s output differs from Node", index, step.Method)
		}
	}
}
