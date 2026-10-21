package app

import (
	"encoding/json"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestPublicMessageProjectionMaterializesTextWithoutChangingPersistedPresence(t *testing.T) {
	for _, text := range []string{"", `,"text":null`} {
		var message contracts.ChatMessage
		if err := json.Unmarshal([]byte(`{"id":"legacy","role":"assistant","attachments":[]`+text+`}`), &message); err != nil {
			t.Fatal(err)
		}
		before, err := json.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		projected := publicMessages([]*contracts.ChatMessage{&message, nil})
		if projected[1] != nil {
			t.Fatal("a missing message became a public message")
		}
		raw, err := json.Marshal(projected[0])
		if err != nil {
			t.Fatal(err)
		}
		var fields contracts.RawObject
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		if string(fields["text"]) != `""` || string(fields["attachments"]) != "[]" {
			t.Fatal("public text requirement changed other storage field presence", fields)
		}
		after, err := json.Marshal(message)
		if err != nil || string(before) != string(after) {
			t.Fatal("public projection modified the authoritative message representation", err)
		}
	}
}
