package contracts

import (
	"bytes"
	"encoding/json"
	"testing"
)

func object(t *testing.T, value any) RawObject {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeObject(raw, len(raw))
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestMessageEmptyTextRemainsPresentOnThePublicWire(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  string
	}{
		{"attachment", `{"id":"attachment","role":"user","text":"","attachments":[{"id":"file","name":"image.png","type":"image/png"}]}`},
		{"call", `{"id":"call","role":"user","text":"","kind":"call","seconds":15}`},
		{"placeholder", `{"id":"placeholder","role":"assistant","text":"","status":"streaming"}`},
		{"legacy omission", `{"id":"legacy","role":"assistant"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			var message ChatMessage
			if err := json.Unmarshal([]byte(test.raw), &message); err != nil {
				t.Fatal(err)
			}

			fields := object(t, message)
			if string(fields["text"]) != `""` {
				t.Fatal("an empty message lost the browser's required text field")
			}
			if _, exists := fields["time"]; exists {
				t.Fatal("a missing creation time was invented")
			}
		})
	}
}

func TestMessageNullableFieldsAndLegacyTextSurviveUnrelatedChanges(t *testing.T) {
	var message ChatMessage
	if err := json.Unmarshal([]byte(`{"id":"legacy","role":"assistant","text":"old\ud800text","time":123,"turnId":null,"pinned":false,"future":{"version":3}}`), &message); err != nil {
		t.Fatal(err)
	}
	message.Read = true
	fields := object(t, message)
	if string(fields["text"]) != `"old\ud800text"` || string(fields["time"]) != "123" || string(fields["turnId"]) != "null" || string(fields["pinned"]) != "false" || string(fields["future"]) != `{"version":3}` {
		t.Fatal("legacy content, null, false or time changed")
	}
	if _, exists := fields["status"]; exists {
		t.Fatal("an omitted status was invented")
	}
	message.Extra["status"] = json.RawMessage(`"completed"`)
	if _, exists := object(t, message)["status"]; exists {
		t.Fatal("a legacy extension bypassed its typed known field")
	}
	message.ClearLegacyText("text")
	message.Text = "\ufffd"
	if bytes.Contains(object(t, message)["text"], []byte(`\ud800`)) {
		t.Fatal("an explicit replacement edit resurrected old text")
	}
}
func TestPlanAndAttachmentFutureFieldsPreserveLegacyEscapedContent(t *testing.T) {
	var work WorkRecord
	if err := json.Unmarshal([]byte(`{"id":"work","turnId":"turn","turnIds":["turn"],"title":"title\udfff","status":"paused","source":"chat","startedAt":123,"updatedAt":456,"plan":{"total":1,"completed":0,"currentStep":"step","steps":[{"step":"step\ud800","status":"pending","futureStep":true}],"futurePlan":4},"futureWork":5}`), &work); err != nil {
		t.Fatal(err)
	}
	fields := object(t, work)
	if string(fields["title"]) != `"title\udfff"` || !bytes.Contains(fields["plan"], []byte(`"step":"step\ud800"`)) || !bytes.Contains(fields["plan"], []byte(`"futureStep":true`)) || !bytes.Contains(fields["plan"], []byte(`"futurePlan":4`)) {
		t.Fatal("plan/title legacy values were lost")
	}
	var attachment Attachment
	if err := json.Unmarshal([]byte(`{"id":"file","name":"file\ud800.bin","size":0,"unavailable":false,"futureAttachment":null}`), &attachment); err != nil {
		t.Fatal(err)
	}
	fields = object(t, attachment)
	if string(fields["name"]) != `"file\ud800.bin"` || string(fields["size"]) != "0" || string(fields["unavailable"]) != "false" || string(fields["futureAttachment"]) != "null" {
		t.Fatal("attachment null/zero/false/legacy filename was changed")
	}
}
func TestOptionalRejectsUnknownStatesAndRetainsExplicitValues(t *testing.T) {
	var status Optional[SubmissionStatus]
	if json.Unmarshal([]byte(`"invented-success"`), &status) == nil {
		t.Fatal("unknown external state became valid")
	}
	for _, test := range []struct {
		raw           string
		present, null bool
	}{{`null`, true, true}, {`"unknown"`, true, false}} {
		if err := json.Unmarshal([]byte(test.raw), &status); err != nil {
			t.Fatal(err)
		}
		if status.Present != test.present || status.Null != test.null {
			t.Fatal("null and omission were collapsed")
		}
	}
}
