package work

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestTrustedExternalAdmissionRequiresTheExactAlreadyPersistedIntegrationMessage(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	reservation, err := engine.ReserveCallStart(context.Background(), "external-admission-hold", "subscription")
	if err != nil {
		t.Fatal(err)
	}
	defer engine.ReleaseCallStart(reservation)
	message, err := persistence.Add(context.Background(), &contracts.ChatMessage{
		Role: contracts.RoleUser, Text: "authenticated integration input", ClientMessageID: "tg:fixture:19",
		Source: contracts.RawObject{"type": raw("telegram"), "updateId": raw(19)},
		Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusDraft)),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []func(*contracts.ChatMessage){
		func(input *contracts.ChatMessage) { input.ID = "not-persisted" },
		func(input *contracts.ChatMessage) { input.Text = "forged replacement text" },
		func(input *contracts.ChatMessage) { input.ClientMessageID = "tg:fixture:20" },
		func(input *contracts.ChatMessage) {
			input.Source = contracts.RawObject{"type": raw("telegram"), "updateId": raw(20)}
		},
		func(input *contracts.ChatMessage) {
			input.Attachments = []contracts.Attachment{{ID: "unverified-file"}}
		},
		func(input *contracts.ChatMessage) { input.WorkReply = &contracts.WorkReplyTarget{WorkID: "other-work"} },
	} {
		input := *message
		mutation(&input)
		if err := engine.AdmitExternalMessage(context.Background(), persistence.ConversationID(), &input); !errors.Is(err, ErrStaleOwner) {
			t.Fatal("integration admission accepted altered durable content or identity", err)
		}
	}
	if err := engine.AdmitExternalMessage(context.Background(), "replaced-conversation", message); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("integration input crossed into a replacement conversation", err)
	}
	for _, input := range []*contracts.ChatMessage{
		nil,
		{Role: contracts.RoleAssistant, ClientMessageID: message.ClientMessageID, Source: message.Source},
		{Role: contracts.RoleUser, ClientMessageID: "public-client-id", Source: message.Source},
		{Role: contracts.RoleUser, ClientMessageID: message.ClientMessageID, Source: contracts.RawObject{"type": raw("untrusted")}},
	} {
		if err := engine.AdmitExternalMessage(context.Background(), persistence.ConversationID(), input); !errors.Is(err, store.ErrInvalidState) {
			t.Fatal("untrusted external message bypassed the public admission contract", err)
		}
	}
	for range 2 {
		if err := engine.AdmitExternalMessage(context.Background(), persistence.ConversationID(), message); err != nil {
			t.Fatal(err)
		}
	}
	if queue := engine.Snapshot().Queue; len(queue) != 1 || queue[0] != message.ID || len(persistence.Snapshot().Messages) != 1 {
		t.Fatal("external duplicate created a second execution or persisted message")
	}
	assertWorkerQuiet(t, worker)
}

func TestExternalAdmissionDoesNotReopenPausedOrAlreadyConfirmedWork(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	for _, scenario := range []string{"paused", "confirmed", "old-turn"} {
		input := &contracts.ChatMessage{
			Role: contracts.RoleUser, Text: "preserved integration input", ClientMessageID: "tg:fixture:" + scenario,
			Source: contracts.RawObject{"type": raw("telegram")}, Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused)),
		}
		switch scenario {
		case "confirmed":
			input.Submission = contracts.Some(contracts.SubmissionStatusConfirmed)
		case "old-turn":
			input.TurnID = contracts.Some("previously-admitted-turn")
		}
		stored, err := persistence.Add(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		err = engine.AdmitExternalMessage(context.Background(), persistence.ConversationID(), stored)
		if scenario == "paused" && !errors.Is(err, ErrPaused) || scenario != "paused" && err != nil {
			t.Fatal("external duplicate changed the known submission contract", scenario, err)
		}
	}
	if len(engine.Snapshot().Queue) != 0 || engine.Snapshot().Active != nil {
		t.Fatal("external duplicates replayed previously accepted or paused work")
	}
	assertWorkerQuiet(t, worker)
}
