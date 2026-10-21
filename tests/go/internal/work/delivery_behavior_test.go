package work

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func deliveryBehaviorFiles(t *testing.T, count int) []contracts.Attachment {
	t.Helper()
	library, err := files.OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	attachments := make([]contracts.Attachment, 0, count)
	for index := 0; index < count; index++ {
		file, err := library.Put(context.Background(), fmt.Sprintf("fixture-%d.txt", index), "text/plain", []byte(fmt.Sprintf("isolated output %d", index)))
		if err != nil {
			t.Fatal(err)
		}
		attachments = append(attachments, file)
	}
	return attachments
}

func TestAttachmentDeliveryUsesOneOwnedChatTargetAndEnforcesItsTotalBudget(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "attachment-delivery-turn")
	attachments := deliveryBehaviorFiles(t, MaxDeliveredFiles+2)
	receipt, err := engine.DeliverAttachments(context.Background(), attachments[:1], owner)
	var delivery struct {
		Sent  bool                   `json:"sent"`
		Files []contracts.Attachment `json:"files"`
	}
	if err != nil || json.Unmarshal(receipt, &delivery) != nil || !delivery.Sent || len(delivery.Files) != 1 || delivery.Files[0].ID != attachments[0].ID {
		t.Fatal("owned file delivery did not return its actual persisted attachment", err)
	}
	if _, err := engine.DeliverAttachments(context.Background(), attachments[:1], owner); !errors.Is(err, store.ErrInvalidState) {
		t.Fatal("duplicate files claimed a second delivery", err)
	}
	receipt, err = engine.DeliverAttachments(context.Background(), attachments[1:], owner)
	if err != nil || json.Unmarshal(receipt, &delivery) != nil || len(delivery.Files) != MaxDeliveredFiles-1 {
		t.Fatal("attachment batch exceeded or underfilled the fixed per-turn budget", err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 2 || state.Messages[1].Role != contracts.RoleAssistant || state.Messages[1].TaskID.Value != message.ID || len(state.Messages[1].Attachments) != MaxDeliveredFiles {
		t.Fatal("files created unrelated chat targets or escaped their owning task")
	}
	for index, file := range state.Messages[1].Attachments {
		if file.ID != attachments[index].ID || file.Hash != attachments[index].Hash {
			t.Fatal("saved attachment identity or bytes hash changed during delivery")
		}
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.Status.Value != contracts.MessageStatus(contracts.TaskStatusRunning) {
		t.Fatal("file delivery falsely completed the entrusted task", err)
	}
	if _, err := engine.DeliverAttachments(context.Background(), []contracts.Attachment{{}}, owner); !errors.Is(err, store.ErrInvalidState) {
		t.Fatal("an unowned empty file identity reached chat", err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.DeliverAttachments(context.Background(), attachments[MaxDeliveredFiles:], owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("a retired owner delivered additional files", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestTextDeliveryDeduplicatesSanitizedTextAndPreservesUTF16Limits(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	engine.options.Redact = func(_ context.Context, text string) string {
		return strings.ReplaceAll(text, "fixture-confidential-value", "[redacted]")
	}
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "text-delivery-turn")
	if _, err := engine.DeliverText(context.Background(), "fixture-confidential-value", owner); err != nil {
		t.Fatal(err)
	}
	receipt, err := engine.DeliverText(context.Background(), "[redacted]", owner)
	var duplicate struct{ Sent, AlreadyDelivered bool }
	if err != nil || json.Unmarshal(receipt, &duplicate) != nil || duplicate.Sent || !duplicate.AlreadyDelivered {
		t.Fatal("identical sanitized text was delivered twice", err)
	}
	if state := persistence.Snapshot(); len(state.Messages) != 2 || state.Messages[1].Text != "[redacted]" {
		t.Fatal("text delivery exposed confidential data or created a duplicate message")
	}
	before := len(persistence.Snapshot().Messages)
	maximum := strings.Repeat("😀", MaxDeliveredTextUnits/2)
	if _, err := engine.DeliverText(context.Background(), maximum+"x", owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("delivery counted Unicode bytes or runes instead of UTF16 units", err)
	}
	if _, err := engine.DeliverText(context.Background(), " \t\n", owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("blank delivery reached chat", err)
	}
	if len(persistence.Snapshot().Messages) != before {
		t.Fatal("rejected text was persisted")
	}
	if _, err := engine.DeliverText(context.Background(), maximum, owner); err != nil {
		t.Fatal("exact-budget UTF16 text was incorrectly rejected", err)
	}
	state := persistence.Snapshot()
	if state.Messages[len(state.Messages)-1].Text != maximum {
		t.Fatal("exact-budget user-visible output was truncated")
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.DeliverText(context.Background(), "stale output", owner); !errors.Is(err, ErrStaleOwner) {
		t.Fatal("a stale task owner delivered into the current conversation", err)
	}
}

func TestAutomaticFileDeliveryRemainsQuietUntilTheExactPlanIsVerified(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	workID, prior := savedUnfinished(t, persistence)
	continueFixture(t, engine, worker, workID, prior, "quiet-file-delivery-turn")
	owner := waitToolScope(t, engine, "quiet-file-delivery-turn")
	attachments := deliveryBehaviorFiles(t, 1)
	if _, err := engine.DeliverAttachments(context.Background(), append(append([]contracts.Attachment{}, attachments...), contracts.Attachment{}), owner); !errors.Is(err, store.ErrInvalidState) {
		t.Fatal("an invalid buffered batch partially entered quiet publication", err)
	}
	receipt, err := engine.DeliverAttachments(context.Background(), attachments, owner)
	var buffered struct{ Sent, Quiet, Buffered bool }
	if err != nil || json.Unmarshal(receipt, &buffered) != nil || buffered.Sent || !buffered.Quiet || !buffered.Buffered || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("unverified automatic file delivery claimed to have sent chat output", err)
	}
	if _, err := engine.Tool(context.Background(), "task_plan", contracts.RawObject{
		"workId": raw(workID), "title": raw("verified isolated file work"),
		"steps": json.RawMessage(`[{"step":"isolated file output verified","status":"completed"}]`),
	}, owner); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(context.Background(), terminal(owner.TurnID, "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || state.Messages[0].Role != contracts.RoleAssistant || len(state.Messages[0].Attachments) != 1 || state.Messages[0].Attachments[0].ID != attachments[0].ID || state.Messages[0].WorkID != workID {
		t.Fatal("verified automatic publication lost or duplicated its exact file")
	}
	assertWorkerQuiet(t, worker)
}
