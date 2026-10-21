package contracts

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
)

func presenceObject(t *testing.T, raw []byte) any {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestMessagePresenceRoundTripRetainsKnownOmittedNullAndZeroFields(t *testing.T) {
	for _, raw := range []string{
		`{"id":"omitted","role":"assistant","status":"completed"}`,
		`{"id":"null","role":"assistant","text":null,"read":null,"reactions":null,"attachments":null,"voice":null,"kind":null,"workReply":null,"workId":null,"turnIds":null,"messageIds":null}`,
		`{"id":"zero","role":"assistant","text":"","read":false,"reactions":[],"attachments":[],"voice":false,"scheduled":false,"kind":"","provider":"","workId":"","clientMessageId":"","callId":"","voiceCallId":"","scheduleId":"","turnIds":[],"messageIds":[],"time":0,"receivedAt":null,"starred":false,"pinned":null}`,
		`{"id":"nested","role":"assistant","text":"old\ud800text","attachments":[{"id":"one","name":"","type":null,"size":0,"hash":"","sha256":null,"guestPath":null,"path":"","sourcePath":"","transcription":null,"unavailable":false,"futureAttachment":null},{"id":"two"}],"futureMessage":{"value":null}}`,
	} {
		t.Run(raw, func(t *testing.T) {
			var message ChatMessage
			if err := json.Unmarshal([]byte(raw), &message); err != nil {
				t.Fatal(err)
			}
			for range 3 {
				encoded, err := json.Marshal(message)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(presenceObject(t, encoded), presenceObject(t, []byte(raw))) {
					t.Fatalf("known field presence changed: %s", encoded)
				}
				if bytes.Contains([]byte(raw), []byte(`old\ud800text`)) && !bytes.Contains(encoded, []byte(`old\ud800text`)) {
					t.Fatal("retaining field presence changed original escaped UTF-16 text")
				}
				if err := json.Unmarshal(encoded, &message); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestMessagePresenceTracksRealTypedChangesWithoutRestoringOldValues(t *testing.T) {
	var message ChatMessage
	if err := json.Unmarshal([]byte(`{"id":"changed","role":"assistant","text":"before","voice":true,"provider":"api","attachments":[{"id":"file","name":"before","transcription":null}]}`), &message); err != nil {
		t.Fatal(err)
	}
	message.Text = ""
	message.Voice = false
	message.Provider = ""
	message.Attachments[0].Name = ""
	message.Attachments[0].Transcription = "recognized"
	fields := object(t, message)
	if string(fields["text"]) != `""` || string(fields["voice"]) != "false" || string(fields["provider"]) != `""` {
		t.Fatal("clearing present fields did not retain their new typed zero values", fields)
	}
	var attachments []RawObject
	if err := json.Unmarshal(fields["attachments"], &attachments); err != nil {
		t.Fatal(err)
	}
	if string(attachments[0]["name"]) != `""` || string(attachments[0]["transcription"]) != `"recognized"` {
		t.Fatal("nested attachment edits were replaced by historical values", attachments)
	}
	message.Attachments = []Attachment{}
	if string(object(t, message)["attachments"]) != "[]" {
		t.Fatal("clearing a present attachment list was omitted")
	}

	if err := json.Unmarshal([]byte(`{"id":"missing","role":"assistant"}`), &message); err != nil {
		t.Fatal(err)
	}
	message.Text = "new"
	message.Read = true
	message.Reactions = []string{}
	fields = object(t, message)
	if string(fields["text"]) != `"new"` || string(fields["read"]) != "true" || string(fields["reactions"]) != "[]" {
		t.Fatal("an edit to an originally omitted field was discarded", fields)
	}
}

func TestAttachmentPresenceRetainsNullWithoutOverridingLaterEdits(t *testing.T) {
	var attachment Attachment
	if err := json.Unmarshal([]byte(`{"id":"file","name":null,"type":"","transcription":null}`), &attachment); err != nil {
		t.Fatal(err)
	}
	fields := object(t, attachment)
	if string(fields["name"]) != "null" || string(fields["type"]) != `""` || string(fields["transcription"]) != "null" {
		t.Fatal("attachment null and zero presence was lost", fields)
	}
	attachment.Name = "authored\u2028name"
	attachment.Transcription = "new words"
	fields = object(t, attachment)
	var name string
	if err := json.Unmarshal(fields["name"], &name); err != nil || name != attachment.Name || string(fields["transcription"]) != `"new words"` {
		t.Fatal("a current attachment edit was replaced", fields, err)
	}
}

func TestMessagePresenceCannotUseExtensionsOrInvalidTypedJSONToOverrideFields(t *testing.T) {
	var message ChatMessage
	if err := json.Unmarshal([]byte(`{"id":"checked","role":"assistant","text":null}`), &message); err != nil {
		t.Fatal(err)
	}
	message.Extra["text"] = json.RawMessage(`"invented"`)
	message.Extra["voice"] = json.RawMessage("true")
	fields := object(t, message)
	if string(fields["text"]) != "null" || fields["voice"] != nil {
		t.Fatal("an extension bypassed checked known-field presence", fields)
	}
	message.Source = RawObject{"invalid": json.RawMessage("undefined")}
	if err := message.RetainLegacyPresence(RawObject{}); err == nil {
		t.Fatal("invalid typed source metadata was accepted as a legacy snapshot")
	}
	if _, err := json.Marshal(message); err == nil {
		t.Fatal("invalid current typed JSON was concealed by saved representation metadata")
	}
}
