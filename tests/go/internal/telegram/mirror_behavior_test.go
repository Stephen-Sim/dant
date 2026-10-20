package telegram

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func ownedTask(t *testing.T, fixture *gatewayFixture, status contracts.TaskStatus) *contracts.ChatMessage {
	t.Helper()
	message := fixture.add(t, contracts.RoleUser, "isolated Telegram request")
	_, err := fixture.Store.Update(t.Context(), message.ID, contracts.MessagePatch{
		"status": raw(status), "turnId": raw("isolated-turn"),
		"source": raw(map[string]any{"type": "telegram", "botId": "11", "chatId": "21", "userId": "31", "pairingId": "fixture-pairing"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	return messageByID(fixture.Store.Snapshot(), message.ID)
}

func TestTerminalResultsRespectDurableWorkAndNeverRepeatAnUnconfirmedDelivery(t *testing.T) {
	for _, scenario := range []string{"completed", "paused", "failed", "submission-unknown", "continuing", "review-incomplete", "review-complete", "interrupted", "legacy"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			status := contracts.TaskStatusCompleted
			if scenario == "paused" {
				status = contracts.TaskStatusPaused
			} else if scenario == "failed" || scenario == "submission-unknown" {
				status = contracts.TaskStatusFailed
			}
			task := ownedTask(t, fixture, status)
			want := fixture.Gateway.word("workFinished")
			switch scenario {
			case "paused":
				want = fixture.Gateway.word("taskPaused")
			case "failed":
				want = fixture.Gateway.word("taskFailed")
			case "submission-unknown":
				if _, err := fixture.Store.Update(t.Context(), task.ID, contracts.MessagePatch{"submission": raw(contracts.SubmissionStatusUnknown)}); err != nil {
					t.Fatal(err)
				}
				want = fixture.Gateway.word("submissionUnknown")
			case "continuing", "review-incomplete", "review-complete":
				if err := fixture.Store.Mutate(t.Context(), func(state *contracts.State) error {
					record := contracts.WorkRecord{ID: "isolated-work", TurnID: "isolated-turn", MessageID: contracts.Some(task.ID), Status: contracts.WorkStatusContinuing}
					if scenario != "continuing" {
						record.Status = contracts.WorkStatusReview
						step := contracts.PlanStepStatusInProgress
						if scenario == "review-complete" {
							step = contracts.PlanStepStatusCompleted
						}
						record.Plan = &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "isolated step", Status: step}}}
					}
					state.WorkTasks = []contracts.WorkRecord{record}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			case "interrupted":
				if _, err := fixture.Store.Update(t.Context(), task.ID, contracts.MessagePatch{"telegramDelivery": raw(deliveryMarker{Key: resultKey(task, "fixture-pairing"), PairingID: "fixture-pairing", Status: MirrorScheduling})}); err != nil {
					t.Fatal(err)
				}
			case "legacy":
				fixture.Gateway.config.ResultKeys = []string{"result:" + task.ID + ":isolated-turn:result"}
			}

			fixture.flush(t)
			fixture.flush(t)
			blocked := scenario == "continuing" || scenario == "review-incomplete" || scenario == "interrupted" || scenario == "legacy"
			if blocked {
				if fixture.Sent.Load() != 0 {
					t.Fatal("unfinished or previously fenced work was announced again")
				}
				if scenario == "interrupted" && deliveryOf(messageByID(fixture.Store.Snapshot(), task.ID)).Status != MirrorUnknown {
					t.Fatal("interrupted result scheduling lost its unknown fence")
				}
			} else if fixture.Sent.Load() != 1 || field(fixture.Bodies[0], "text") != want {
				t.Fatal("terminal acknowledgement did not preserve its actual outcome")
			}
			if fixture.Admitted.Load() != 0 {
				t.Fatal("delivery of an existing result admitted more execution")
			}
		})
	}
}

func TestMirrorOwnershipExcludesForeignOrphansAndAllowsOnlyCurrentVoiceReferences(t *testing.T) {
	fixture := fixture(t)
	foreign := ownedTask(t, fixture, contracts.TaskStatusRunning)
	if _, err := fixture.Store.Update(t.Context(), foreign.ID, contracts.MessagePatch{"source": raw(map[string]any{"type": "telegram", "botId": "11", "chatId": "21", "userId": "31", "pairingId": "old-pairing"})}); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"foreign", "orphan", "voice-current", "voice-old", "call", "not-complete", "historical", "old-marker"} {
		message := fixture.add(t, contracts.RoleAssistant, scenario)
		patch := contracts.MessagePatch{"taskId": raw("missing-task")}
		switch scenario {
		case "foreign":
			patch["taskId"] = raw(foreign.ID)
		case "voice-current", "voice-old":
			conversation := fixture.Store.ConversationID()
			if scenario == "voice-old" {
				conversation = "different-conversation"
			}
			patch["source"] = raw(map[string]any{"type": "voice-call", "conversationId": conversation})
		case "call":
			patch["kind"] = raw("call")
		case "not-complete":
			patch["status"] = raw(contracts.TaskStatusRunning)
		case "historical":
			patch["taskId"] = raw(nil)
			patch["telegramMirror"] = raw(mirrorMarker{PairingID: "fixture-pairing", Historical: true})
		case "old-marker":
			patch["taskId"] = raw(nil)
			patch["telegramMirror"] = raw(mirrorMarker{PairingID: "old-pairing"})
		}
		if _, err := fixture.Store.Update(t.Context(), message.ID, patch); err != nil {
			t.Fatal(err)
		}
	}
	fixture.flush(t)
	fixture.Now.Add(2)
	fixture.flush(t)
	if fixture.Sent.Load() != 1 || field(fixture.Bodies[0], "text") != "voice-current" {
		t.Fatal("message mirroring crossed a pairing, task or conversation ownership boundary")
	}
}

func TestInterruptedMirrorFencesEveryComponentAndPreventsLaterFileReplay(t *testing.T) {
	fixture := fixture(t)
	message := fixture.add(t, contracts.RoleAssistant, "isolated interrupted reply")
	group := "mirror:fixture-pairing:" + message.ID
	if _, err := fixture.Store.Update(t.Context(), message.ID, contracts.MessagePatch{
		"telegramMirror": raw(mirrorMarker{PairingID: "fixture-pairing", Text: mirrorStatus(MirrorScheduling), Files: []mirrorFile{{ID: "isolated-file", Status: MirrorScheduling}}}),
	}); err != nil {
		t.Fatal(err)
	}
	fixture.Gateway.config.Outbox = []*OutboxItem{{
		ID: "interrupted-component", Kind: "text", Text: "isolated pending component", DeliveryID: group,
		BotID: "11", ChatID: "21", UserID: "31", PairingID: "fixture-pairing", Status: OutboxQueued,
	}}
	if err := fixture.Gateway.Scan(t.Context()); err != nil {
		t.Fatal(err)
	}
	marker := mirrorOf(messageByID(fixture.Store.Snapshot(), message.ID))
	if marker.Text == nil || *marker.Text != MirrorUnknown || marker.Files[0].Status != MirrorUnknown || fixture.Gateway.config.Outbox[0].Status != OutboxFailed {
		t.Fatal("partially persisted mirror scheduling lost its unknown fence")
	}
	fixture.flush(t)
	fixture.flush(t)
	if fixture.Sent.Load() != 0 {
		t.Fatal("unknown mirror component was resent")
	}
}

func TestFullForwardingPreservesUserLinksAndReadSuppressionIsPermanent(t *testing.T) {
	fixture := fixture(t)
	user := fixture.add(t, contracts.RoleUser, "authored [local](file:///isolated/path.txt) [site](https://example.invalid)")
	assistant := fixture.add(t, contracts.RoleAssistant, "already observed")
	if _, err := fixture.Store.Update(t.Context(), assistant.ID, contracts.MessagePatch{"read": raw(true)}); err != nil {
		t.Fatal(err)
	}
	if err := fixture.Gateway.Scan(t.Context()); err != nil {
		t.Fatal(err)
	}
	mode := ForwardAll
	if _, err := fixture.Gateway.Configure(t.Context(), ConfigureInput{ForwardMode: &mode}); err != nil {
		t.Fatal(err)
	}
	fixture.flush(t)
	if fixture.Sent.Load() != 0 {
		t.Fatal("changing policy replayed content already suppressed by observed state")
	}
	newUser := fixture.add(t, contracts.RoleUser, user.Text)
	fixture.flush(t)
	if fixture.Sent.Load() != 1 || !strings.HasPrefix(field(fixture.Bodies[0], "text"), fixture.Gateway.word("desktop")) || !strings.Contains(field(fixture.Bodies[0], "text"), "file:///isolated/path.txt") {
		t.Fatal("full forwarding stripped authored links or lost the desktop origin")
	}
	if mirrorOf(messageByID(fixture.Store.Snapshot(), newUser.ID)).Text == nil {
		t.Fatal("successful full forwarding did not persist its message intent")
	}
}

func TestMirrorQueuePressureIsAtomicAndRetiresOnlyConfirmedOldDeliveries(t *testing.T) {
	fixture := fixture(t)
	fixture.Gateway.mu.Lock()
	for index := 0; index < MaxOutbox; index++ {
		fixture.Gateway.config.Outbox = append(fixture.Gateway.config.Outbox, &OutboxItem{
			ID: strings.Repeat("x", index+1), Kind: "text", Text: "isolated queued intent",
			BotID: "11", ChatID: "21", UserID: "31", PairingID: "fixture-pairing", Status: OutboxQueued,
		})
	}
	fixture.Gateway.mu.Unlock()
	message := fixture.add(t, contracts.RoleAssistant, "new reply waiting for capacity")
	if err := fixture.Gateway.Scan(t.Context()); err != nil {
		t.Fatal(err)
	}
	marker := mirrorOf(messageByID(fixture.Store.Snapshot(), message.ID))
	if len(fixture.Gateway.config.Outbox) != MaxOutbox || marker.Text == nil || *marker.Text != MirrorPending {
		t.Fatal("full delivery queue lost an accepted intent or claimed the new message was scheduled")
	}
	fixture.Gateway.config.Outbox[0].Status = OutboxSent
	if err := fixture.Gateway.Scan(t.Context()); err != nil {
		t.Fatal(err)
	}
	marker = mirrorOf(messageByID(fixture.Store.Snapshot(), message.ID))
	if len(fixture.Gateway.config.Outbox) != MaxOutbox || *marker.Text != MirrorScheduled || fixture.Gateway.config.Outbox[len(fixture.Gateway.config.Outbox)-1].LocalMessageID != message.ID {
		t.Fatal("queue failed to use capacity from a confirmed terminal delivery")
	}
}

func TestExplicitCommandAcknowledgementBypassesVisibilityGraceWithoutReorderingMirrorParts(t *testing.T) {
	fixture := fixture(t)
	fixture.add(t, contracts.RoleAssistant, "pending assistant reply")
	fixture.flush(t)
	if response := commandResponse(t, fixture, 100, "/status"); !strings.Contains(response, fixture.Gateway.word("progress")) {
		t.Fatal("status command did not produce its independent acknowledgement")
	}
	fixture.flush(t)
	if fixture.Sent.Load() != 1 || strings.Contains(field(fixture.Bodies[0], "text"), "pending assistant reply") {
		t.Fatal("command waited behind unread visibility grace or swallowed an unsent mirror")
	}
	fixture.Now.Add(2)
	fixture.flush(t)
	if fixture.Sent.Load() != 2 || field(fixture.Bodies[1], "text") != "pending assistant reply" || string(fixture.Bodies[1]["disable_notification"]) == "true" {
		t.Fatal("command bypass changed mirror contents or notification identity")
	}
}

func TestPairingReplacementFailsQueuedIntentsWithoutContactingTelegram(t *testing.T) {
	fixture := fixture(t)
	fixture.add(t, contracts.RoleAssistant, "reply for original pairing")
	fixture.flush(t)
	fixture.Gateway.config.Owner.PairingID = "replacement-pairing"
	fixture.Gateway.config.Owner.SyncVersion = 0
	fixture.Now.Add(2)
	fixture.flush(t)
	if fixture.Sent.Load() != 0 || fixture.Gateway.config.Outbox[0].Status != OutboxFailed {
		t.Fatal("queued delivery was sent to a replacement owner")
	}
	fixture.Send = func(*http.Request) (*http.Response, error) {
		t.Fatal("foreign queued intent reached the transport")
		return nil, context.Canceled
	}
	fixture.flush(t)
}
