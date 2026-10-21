package voice

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestVoiceToolArgumentBoundaryRetainsOnlyDeclaredValidatedFields(t *testing.T) {
	for _, test := range []struct{ name, raw string }{
		{"unknown", `{}`}, {"run_task", `"unterminated`}, {"run_task", `null`}, {"run_task", `{}`}, {"run_task", `{"text":"request","unknown":true}`}, {"run_task", `{"text":null}`}, {"run_task", `{"text":"a\u0000b"}`}, {"run_task", `{"text":" "}`},
		{"react_message", `{"messageId":"message","emoji":"👍👍"}`}, {"react_message", `{"messageId":"message","emoji":false}`},
		{"skill_save", `{"name":"fixture","description":"fixture","instructions":"fixture","enabled":null}`}, {"skill_save", `{"name":"fixture","description":"fixture","instructions":"fixture","files":false}`}, {"skill_save", `{"name":"fixture","description":"fixture","instructions":"fixture","files":{"helper.py":null}}`},
		{"send_file", `{"path":"relative/file.txt"}`},
	} {
		if _, err := voiceToolArguments(test.name, json.RawMessage(test.raw)); !errors.Is(err, ErrCallInput) {
			t.Fatal("invalid voice tool arguments crossed their declared schema", test.name, err)
		}
	}
	for _, test := range []struct{ name, raw string }{
		{"run_task", `"{\"text\":\"quoted request\"}"`},
		{"react_message", `{"messageId":"message","emoji":null}`},
		{"react_message", `{"messageId":"message","emoji":"👍"}`},
		{"skill_save", `{"name":"fixture","description":"fixture","instructions":"fixture","enabled":true,"files":{"helper.py":"authored fixture"}}`},
		{"send_file", `{"path":"/workspace/output/file.txt"}`},
	} {
		if _, err := voiceToolArguments(test.name, json.RawMessage(test.raw)); err != nil {
			t.Fatal("valid voice tool input was rejected", test.name, err)
		}
	}
	oversized, _ := json.Marshal(map[string]string{"workId": strings.Repeat("x", 129)})
	if _, err := voiceToolArguments("task_cancel", oversized); !errors.Is(err, ErrCallInput) {
		t.Fatal("oversized work owner accepted", err)
	}
	files := map[string]string{}
	for i := range 129 {
		files[strings.Repeat("x", i+1)] = "content"
	}
	oversized, _ = json.Marshal(map[string]any{"name": "fixture", "description": "fixture", "instructions": "fixture", "files": files})
	if _, err := voiceToolArguments("skill_save", oversized); !errors.Is(err, ErrCallInput) {
		t.Fatal("oversized skill file set accepted", err)
	}
	for _, files := range []map[string]string{{strings.Repeat("x", 181): "content"}, {"file.txt": strings.Repeat("x", 65537)}} {
		raw, _ := json.Marshal(map[string]any{"name": "fixture", "description": "fixture", "instructions": "fixture", "files": files})
		if _, err := voiceToolArguments("skill_save", raw); !errors.Is(err, ErrCallInput) {
			t.Fatal("oversized skill path or contents accepted", err)
		}
	}
	first := VoiceTools()
	first[0][0] = 'x'
	if !json.Valid(VoiceTools()[0]) || !validAPIVoice("marin") || validAPIVoice("unknown") {
		t.Fatal("borrowed tool schema bytes or unknown voice changed shared assets")
	}
}
