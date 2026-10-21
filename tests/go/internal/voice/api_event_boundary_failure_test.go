package voice

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type failingVoiceWriter struct{ *fakeVoiceSocket }

func (failingVoiceWriter) Write(context.Context, []byte) error {
	return errors.New("isolated sideband write failure")
}

func eventOnlyAPIFixture(t *testing.T) (*API, *apiSession, *fakeVoiceSocket) {
	t.Helper()
	api, socket, _ := apiFixture(t, APIOptions{})
	_, session := conversationSessionFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	session.ctx, session.cancel = ctx, cancel
	session.socket, session.ready = socket, true
	session.tools = map[string]bool{}
	session.toolQueue = make(chan apiTool, 2)
	session.subtitles = NewSubtitles(session.callID, "api", func(text string) string { return text })
	session.cleanupDone = make(chan struct{})
	api.session, api.owned = session, session
	return api, session, socket
}

func TestAPIProviderEventsRefuseToolCapacityWithoutStartingExtraWork(t *testing.T) {
	for _, capacity := range []string{"registry", "queue"} {
		t.Run(capacity, func(t *testing.T) {
			api, session, socket := eventOnlyAPIFixture(t)
			if capacity == "registry" {
				for index := 0; index < maxAPITools; index++ {
					session.tools[fmt.Sprintf("owned-tool-%d", index)] = true
				}
			} else {
				for range cap(session.toolQueue) {
					session.toolQueue <- apiTool{}
				}
			}
			api.handle(session, apiEvent(`{"type":"response.done","response":{"status":"completed","output":[{"type":"function_call","call_id":"overflow-tool","name":"task_list"}]}}`))
			if err := api.Close(t.Context()); err != nil {
				t.Fatal("overloaded sideband did not join its media owner", err)
			}
			state := api.Snapshot()
			if state.Error == nil || *state.Error != ErrVoiceBusy.Error() || state.Call != nil || socket.count("conversation.item.create") != 0 {
				t.Fatal("tool overflow claimed execution or lost its bounded fixed diagnostic")
			}
		})
	}
}

func TestAPIProviderTranscriptDeletionAndIncompleteResponsesCannotBecomeFinalSpeech(t *testing.T) {
	api, session, _ := eventOnlyAPIFixture(t)
	api.handle(session, contracts.RawObject{})
	for _, event := range []string{
		`{"type":"conversation.item.added","item":{"id":"","type":"message","role":"assistant"}}`,
		`{"type":"input_audio_buffer.committed","item_id":"failed-audio","previous_item_id":null}`,
		`{"type":"conversation.item.input_audio_transcription.failed","item_id":"failed-audio"}`,
		`{"type":"conversation.item.added","previous_item_id":"failed-audio","item":{"id":"incomplete-assistant","type":"message","role":"assistant"}}`,
		`{"type":"response.done","response":{"status":"incomplete","output":[{"id":"incomplete-assistant","type":"message","role":"assistant","status":"completed","content":[{"type":"audio","transcript":"Unverified synthetic speech"}]}]}}`,
		`{"type":"response.done","response":{"status":"completed","output":[{"id":"","type":"message","role":"assistant"}]}}`,
		`{"type":"error","error":{"code":"response_already_in_progress"}}`,
	} {
		api.handle(session, apiEvent(event))
	}
	if len(session.conversationQueue) != 0 || session.conversation["failed-audio"].state != "skip" || session.conversation["incomplete-assistant"].state != "skip" || !session.activeResponse || !session.needsResponse {
		t.Fatal("failed/incomplete transcripts became speech or provider response ownership was cleared")
	}
	api.session = nil
	api.handle(session, apiEvent(`{"type":"response.created"}`))
	if err := api.write(t.Context(), session, contracts.RawObject{}); !errors.Is(err, ErrVoiceConnection) {
		t.Fatal("detached session wrote to a sideband socket", err)
	}
}

func TestAPIResponseWriteFailureClosesItsOwnedMediaWithASafeDiagnostic(t *testing.T) {
	api, session, socket := eventOnlyAPIFixture(t)
	session.socket = failingVoiceWriter{socket}
	session.needsResponse = true
	api.respond(session)
	if err := api.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	state := api.Snapshot()
	if state.Error == nil || *state.Error != ErrVoiceConnection.Error() || state.Call != nil {
		t.Fatal("failed response request exposed raw transport errors or retained active media")
	}
}

func TestAPIReadLoopSkipsMalformedFramesAndContinuesTheSameOwnedSession(t *testing.T) {
	usage := make(chan contracts.RawObject, 1)
	api, socket, _ := apiFixture(t, APIOptions{Usage: func(event contracts.RawObject) { usage <- event }})
	startAPIFixture(t, api)
	socket.input <- []byte(`{"type":`)
	socket.emit(apiEvent(`{"type":"response.done","response":{"id":"after-invalid-frame","status":"completed"}}`))
	if event := <-usage; textField(event, "responseId") != "after-invalid-frame" || api.Snapshot().Call == nil {
		t.Fatal("invalid observer frame corrupted or replaced the current sideband session")
	}
}
