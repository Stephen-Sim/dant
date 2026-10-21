package telegram

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type controlledMirrorPersistence struct {
	Persistence
	mutate func(context.Context, func(*contracts.State) error) error
}

func (persistence controlledMirrorPersistence) Mutate(ctx context.Context, update func(*contracts.State) error) error {
	if persistence.mutate != nil {
		return persistence.mutate(ctx, update)
	}
	return persistence.Persistence.Mutate(ctx, update)
}

func TestTelegramHistoryBaselineRecordsExistingTaskResultsWithoutSendingThem(t *testing.T) {
	fixture := fixture(t)
	task := ownedTask(t, fixture, contracts.TaskStatusCompleted)
	reply := fixture.add(t, contracts.RoleAssistant, "synthetic historical result")
	if _, err := fixture.Store.Update(t.Context(), reply.ID, contracts.MessagePatch{"taskId": raw(task.ID)}); err != nil {
		t.Fatal(err)
	}
	fixture.Gateway.config.Owner.SyncVersion = 0
	fixture.flush(t)
	snapshot := fixture.Store.Snapshot()
	marker := deliveryOf(messageByID(snapshot, task.ID))
	if fixture.Sent.Load() != 0 || marker.Status != MirrorHistorical || marker.ReplyThroughID == nil || *marker.ReplyThroughID != reply.ID {
		t.Fatal("historical results were replayed or lost their reply boundary")
	}
	fixture.Gateway.config.Owner.SyncVersion = 0
	fixture.flush(t)
	if second := deliveryOf(messageByID(fixture.Store.Snapshot(), task.ID)); second.Key != marker.Key || second.ScheduledAt != marker.ScheduledAt || fixture.Sent.Load() != 0 {
		t.Fatal("a repeated baseline changed an existing result receipt")
	}
}

func TestTelegramMirrorMutationsRejectChangedConversationAndMissingMessageIdentity(t *testing.T) {
	fixture := fixture(t)
	message := fixture.add(t, contracts.RoleAssistant, "synthetic result")
	conversation := fixture.Store.ConversationID()
	for _, identity := range [][2]string{{"foreign-conversation", message.ID}, {conversation, "missing-message"}} {
		for _, operation := range []func() error{
			func() error {
				return fixture.Gateway.updateMirror(t.Context(), identity[0], identity[1], mirrorMarker{PairingID: "fixture-pairing"})
			},
			func() error {
				return fixture.Gateway.updateDelivery(t.Context(), identity[0], identity[1], deliveryMarker{Key: "uncommitted"})
			},
		} {
			if err := operation(); !errors.Is(err, ErrIncoming) {
				t.Fatal("stale identity committed a Telegram marker", err)
			}
		}
	}
	if marker := mirrorOf(messageByID(fixture.Store.Snapshot(), message.ID)); marker.PairingID != "" {
		t.Fatal("failed ownership checks changed the real message")
	}
	fixture.Gateway.config.Owner.SyncVersion = 0
	fixture.Gateway.options.Store = controlledMirrorPersistence{Persistence: fixture.Store, mutate: func(ctx context.Context, update func(*contracts.State) error) error {
		state := fixture.Store.Snapshot()
		state.ConversationID = "changed-before-commit"
		return update(&state)
	}}
	if err := fixture.Gateway.Scan(t.Context()); !errors.Is(err, ErrIncoming) || fixture.Sent.Load() != 0 || fixture.Gateway.config.Owner.SyncVersion != 0 {
		t.Fatal("failed historical baseline advanced synchronization or delivered content", err)
	}
}

func TestTelegramQueueDuplicatesAndStoragePressurePreserveExistingIntent(t *testing.T) {
	fixture := fixture(t)
	gateway := fixture.Gateway
	item := &OutboxItem{ID: "synthetic-intent", Kind: "text", Text: "synthetic body"}
	accepted, err := gateway.queueBatchLocked(t.Context(), []*OutboxItem{item, item})
	if err != nil || !accepted || len(gateway.config.Outbox) != 1 {
		t.Fatal("duplicate queue identity admitted another external action", err)
	}
	accepted, err = gateway.queueBatchLocked(t.Context(), []*OutboxItem{{ID: "too-large", Kind: "text", Text: strings.Repeat("x", MaxConfigBytes)}})
	if err != nil || accepted || len(gateway.config.Outbox) != 1 || gateway.config.Outbox[0].ID != item.ID {
		t.Fatal("queue byte pressure discarded an existing intent", err)
	}
	original := gateway.file
	gateway.file = fixture.Directory
	accepted, err = gateway.queueBatchLocked(t.Context(), []*OutboxItem{{ID: "unpersisted", Kind: "text", Text: "new body"}})
	gateway.file = original
	if err == nil || accepted || len(gateway.config.Outbox) != 1 {
		t.Fatal("an unpersisted external intent remained queued", err)
	}
	gateway.config.Owner = nil
	if accepted, err := gateway.queueBatchLocked(t.Context(), []*OutboxItem{item}); err != nil || accepted {
		t.Fatal("an unpaired gateway admitted delivery", err)
	}
}

func TestTelegramReadAttachmentSuppressionRemainsPermanentAcrossPolicyChanges(t *testing.T) {
	fixture := fixture(t)
	for _, existing := range []bool{false, true} {
		message := fixture.add(t, contracts.RoleAssistant, "")
		attachment := contracts.Attachment{ID: "synthetic-file", Name: "fixture.bin"}
		marker := mirrorMarker{PairingID: "fixture-pairing", Text: mirrorStatus(MirrorScheduled)}
		if existing {
			marker.Files = []mirrorFile{{ID: attachment.ID, Status: MirrorScheduled}}
		}
		if _, err := fixture.Store.Update(t.Context(), message.ID, contracts.MessagePatch{"attachments": raw([]contracts.Attachment{attachment}), "visibleAttachmentIds": raw([]string{attachment.ID}), "telegramMirror": raw(marker)}); err != nil {
			t.Fatal(err)
		}
		fixture.Gateway.config.Outbox = []*OutboxItem{{ID: "queued-file", Kind: "document", AttachmentID: attachment.ID, LocalMessageID: message.ID, MirrorRole: contracts.RoleAssistant, BotID: "11", ChatID: "21", UserID: "31", PairingID: "fixture-pairing", Status: OutboxQueued}}
		fixture.flush(t)
		if fixture.Sent.Load() != 0 || fixture.Gateway.config.Outbox[0].Status != OutboxSuppressed {
			t.Fatal("an observed attachment was sent")
		}
		latest := messageByID(fixture.Store.Snapshot(), message.ID)
		if !fixture.Gateway.suppress(latest, "document", attachment.ID) {
			t.Fatal("attachment suppression was not retained")
		}
		fixture.Gateway.config.ForwardMode = ForwardAll
		if !fixture.Gateway.suppress(latest, "document", attachment.ID) {
			t.Fatal("policy change revived a permanently suppressed attachment")
		}
		fixture.Gateway.config.ForwardMode = ForwardUnread
	}
}

func TestTelegramSilentRepliesRequireAConfirmedRecentAssistantDelivery(t *testing.T) {
	fixture := fixture(t)
	gateway := fixture.Gateway
	for _, scenario := range []string{"same-delivery", "different-delivery", "future", "old", "fallback-at", "fallback-attempt", "user"} {
		prior := &OutboxItem{ID: "previous", MirrorRole: contracts.RoleAssistant, LocalMessageID: "retained-message", DeliveryID: "delivery", Status: OutboxSent, SentAt: fixture.Now.Load() - 1}
		next := &OutboxItem{ID: "next", MirrorRole: contracts.RoleAssistant, LocalMessageID: "retained-message", DeliveryID: "delivery", Status: OutboxQueued}
		switch scenario {
		case "different-delivery":
			next.DeliveryID = "other"
		case "future":
			prior.SentAt = fixture.Now.Load() + 1
		case "old":
			prior.SentAt = 1
		case "fallback-at":
			prior.SentAt = 0
			prior.At = fixture.Now.Load() - 1
		case "fallback-attempt":
			prior.SentAt = 0
			prior.LastAttemptAt = fixture.Now.Load() - 1
		case "user":
			next.MirrorRole = contracts.RoleUser
		}
		gateway.config.CombineReplies = false
		gateway.config.Outbox = []*OutboxItem{prior, next}
		want := scenario == "same-delivery" || scenario == "fallback-at" || scenario == "fallback-attempt"
		if gateway.silentLocked([]*OutboxItem{next}) != want {
			t.Fatal("notification suppression crossed its delivery or time boundary", scenario)
		}
	}
}
