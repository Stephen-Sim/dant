package telegram

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestGatewayStartupRejectsInvalidCapabilitiesAndLimitsWithoutPublishingConfiguration(t *testing.T) {
	fixture := fixture(t)
	for _, scenario := range []string{"store", "attachments", "admit", "snapshot", "poll", "retry", "grace"} {
		t.Run(scenario, func(t *testing.T) {
			options := fixture.Gateway.options
			switch scenario {
			case "store":
				options.Store = nil
			case "attachments":
				options.Attachments = nil
			case "admit":
				options.Admit = nil
			case "snapshot":
				options.WorkSnapshot = nil
			case "poll":
				options.PollTimeout = time.Millisecond
			case "retry":
				options.RetryBase = 31 * time.Second
			case "grace":
				options.MirrorGrace = -time.Millisecond
			}
			directory := filepath.Join(t.TempDir(), "unopened")
			if gateway, err := Open(t.Context(), directory, options); !errors.Is(err, ErrConfig) || gateway != nil {
				t.Fatal("invalid startup contract produced a live gateway")
			}
			if _, err := os.Lstat(directory); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("startup validation wrote configuration before validating its capabilities")
			}
		})
	}
	options := fixture.Gateway.options
	options.Now, options.Random, options.Redact, options.HTTP = nil, nil, nil, nil
	options.PollTimeout, options.RetryBase, options.MirrorGrace = 0, 0, 0
	gateway, err := Open(t.Context(), t.TempDir(), options)
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(t.Context())
	if gateway.options.PollTimeout != 25*time.Second || gateway.options.RetryBase != time.Second || gateway.options.MirrorGrace != 2500*time.Millisecond || gateway.options.Redact("isolated") != "isolated" {
		t.Fatal("omitted startup options lost documented defaults")
	}
}

func TestPairingFailureNeverPublishesAnUnpersistedCodeOrReplacesPriorChallenge(t *testing.T) {
	for _, scenario := range []string{"random-error", "random-short", "save", "expired", "no-token"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			fixture.Gateway.config.Owner = nil
			fixture.Gateway.config.Pairing = &Pairing{Hash: digest("old-isolated-challenge"), ExpiresAt: 30000}
			before := *fixture.Gateway.config.Pairing
			switch scenario {
			case "random-error":
				fixture.Gateway.options.Random = func([]byte) (int, error) { return 0, errors.New("isolated entropy failure") }
			case "random-short":
				fixture.Gateway.options.Random = func([]byte) (int, error) { return 15, nil }
			case "save":
				fixture.Gateway.file = fixture.Directory
			case "no-token":
				fixture.Gateway.config.Token = nil
			case "expired":
				fixture.Gateway.config.Pairing = &Pairing{Hash: digest("31313131313131313131313131313131"), ExpiresAt: fixture.Now.Load()}
				if err := fixture.Gateway.Receive(t.Context(), behaviorUpdate(t, 100, "/start 31313131313131313131313131313131")); err != nil || fixture.Gateway.config.Owner != nil {
					t.Fatal("expired pairing code bound an owner")
				}
				if string(fixture.Gateway.Status()["pairing"]) != "null" {
					t.Fatal("expired pairing was still advertised as usable")
				}
				return
			}
			result, err := fixture.Gateway.Pair(t.Context())
			if !errors.Is(err, ErrConfig) || result.Code != "" || *fixture.Gateway.config.Pairing != before {
				t.Fatal("failed pairing published a code or replaced the durable challenge")
			}
		})
	}
}

func TestLegacyConfigurationRestoresIdentityOnlyWhenItCanBeProved(t *testing.T) {
	fixture := fixture(t)
	for _, scenario := range []string{"matching", "foreign", "legacy-results"} {
		t.Run(scenario, func(t *testing.T) {
			value := object(fixture.Gateway.config)
			delete(value, "forwardMode")
			delete(value, "combineReplies")
			item := &OutboxItem{ID: "legacy-intent", Kind: "text", Text: "isolated legacy reply", BotID: "11", ChatID: "21", UserID: "31", Status: OutboxQueued}
			if scenario == "foreign" {
				item.ChatID = "22"
			}
			value["outbox"] = raw([]*OutboxItem{item})
			if scenario == "legacy-results" {
				delete(value, "deliveryVersion")
				value["resultKeys"] = raw([]string{"result:legacy-task:legacy-turn:result"})
			}
			data := raw(value)
			config, changed, err := restoreConfig(data)
			if err != nil || !changed || config.ForwardMode != ForwardUnread || !config.CombineReplies {
				t.Fatal("supported legacy configuration did not retain safe defaults")
			}
			if scenario == "foreign" {
				if config.Outbox[0].Status != OutboxFailed || config.Outbox[0].PairingID != "" {
					t.Fatal("legacy intent invented ownership for a foreign recipient")
				}
			} else if config.Outbox[0].PairingID != "fixture-pairing" || config.Outbox[0].Status != OutboxQueued {
				t.Fatal("provable existing recipient identity was lost")
			}
			if scenario == "legacy-results" && config.Owner.SyncVersion != 0 {
				t.Fatal("legacy result receipts skipped their required historical baseline")
			}
			if !bytes.Equal(data, raw(value)) {
				t.Fatal("validation modified its input bytes")
			}
		})
	}
}

func TestVisibleFileSuppressionPersistsPerAttachmentWithoutSuppressingNewComponents(t *testing.T) {
	fixture := fixture(t)
	first, err := fixture.Gateway.options.Attachments.Put(t.Context(), "first.txt", "text/plain", []byte("isolated first file"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := fixture.Gateway.options.Attachments.Put(t.Context(), "second.txt", "text/plain", []byte("isolated second file"))
	if err != nil {
		t.Fatal(err)
	}
	message := fixture.add(t, contracts.RoleAssistant, "read text with one observed file")
	if _, err := fixture.Store.Update(t.Context(), message.ID, contracts.MessagePatch{
		"read": raw(true), "attachments": raw([]contracts.Attachment{first, second}), "visibleAttachmentIds": raw([]string{first.ID}),
	}); err != nil {
		t.Fatal(err)
	}
	fixture.flush(t)
	fixture.Now.Add(2)
	fixture.flush(t)
	marker := mirrorOf(messageByID(fixture.Store.Snapshot(), message.ID))
	if fixture.Sent.Load() != 1 || marker.Text == nil || *marker.Text != MirrorSuppressed || len(marker.Files) != 2 || marker.Files[0].Status != MirrorSuppressed || marker.Files[1].Status != MirrorScheduled {
		t.Fatal("read text or observed file suppression swallowed an unseen file")
	}
	third, err := fixture.Gateway.options.Attachments.Put(t.Context(), "third.txt", "text/plain", []byte("isolated later file"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.Store.Update(t.Context(), message.ID, contracts.MessagePatch{"attachments": raw([]contracts.Attachment{first, second, third})}); err != nil {
		t.Fatal(err)
	}
	fixture.flush(t)
	fixture.Now.Add(2)
	fixture.flush(t)
	if fixture.Sent.Load() != 2 {
		t.Fatal("a newly attached component was lost or existing components replayed")
	}
}

func TestResultAnchorDoesNotReplayOldRepliesWhenAnAcceptedTaskContinuesOnAnotherTurn(t *testing.T) {
	fixture := fixture(t)
	task := ownedTask(t, fixture, contracts.TaskStatusPaused)
	reply := fixture.add(t, contracts.RoleAssistant, "first accepted turn reply")
	if _, err := fixture.Store.Update(t.Context(), reply.ID, contracts.MessagePatch{"taskId": raw(task.ID)}); err != nil {
		t.Fatal(err)
	}
	fixture.flush(t)
	fixture.Now.Add(2)
	fixture.flush(t)
	sent := fixture.Sent.Load()
	if _, err := fixture.Store.Update(t.Context(), task.ID, contracts.MessagePatch{"status": raw(contracts.TaskStatusCompleted), "turnId": raw("second-isolated-turn")}); err != nil {
		t.Fatal(err)
	}
	fixture.flush(t)
	if fixture.Sent.Load() != sent+1 || field(fixture.Bodies[len(fixture.Bodies)-1], "text") != fixture.Gateway.word("workFinished") {
		t.Fatal("continuation replayed the anchored reply instead of its new terminal acknowledgement")
	}
	if err := fixture.Store.Mutate(context.Background(), func(state *contracts.State) error {
		for _, message := range state.Messages {
			if message.ID == task.ID {
				message.TurnID = contracts.Some("third-isolated-turn")
			}
		}
		state.Messages = state.Messages[:1]
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	fixture.flush(t)
	if fixture.Sent.Load() != sent+2 || field(fixture.Bodies[len(fixture.Bodies)-1], "text") != fixture.Gateway.word("workFinished") {
		t.Fatal("missing historical anchor caused replay of a deleted reply")
	}
}

func TestRestoredConfigurationRejectsAmbiguousOrUnboundedPersistentShapes(t *testing.T) {
	fixture := fixture(t)
	for _, scenario := range []string{"null-enabled", "null-offset", "bad-outbox", "null-outbox-id", "null-text", "null-receipt-id", "negative-receipt", "unsafe-receipt", "negative-attempts", "negative-time", "unknown-status", "non-object", "huge"} {
		t.Run(scenario, func(t *testing.T) {
			value := object(fixture.Gateway.config)
			intent := object(OutboxItem{ID: "bounded-intent", Kind: "text", Text: "isolated", BotID: "11", ChatID: "21", UserID: "31", Status: OutboxQueued})
			switch scenario {
			case "null-enabled":
				value["enabled"] = raw(nil)
			case "null-offset":
				value["offset"] = raw(nil)
			case "bad-outbox":
				value["outbox"] = raw([]any{nil})
			case "null-outbox-id":
				intent["id"] = raw(nil)
				value["outbox"] = raw([]contracts.RawObject{intent})
			case "null-text":
				intent["text"] = raw(nil)
				value["outbox"] = raw([]contracts.RawObject{intent})
			case "null-receipt-id":
				value["receipts"] = raw([]contracts.RawObject{{"id": raw(nil), "status": raw(ReceiptDone)}})
			case "negative-receipt":
				value["receipts"] = raw([]Receipt{{ID: -1, Status: ReceiptDone}})
			case "unsafe-receipt":
				value["receipts"] = raw([]Receipt{{ID: 9007199254740991, Status: ReceiptDone}})
			case "negative-attempts":
				intent["attempts"] = raw(-1)
				value["outbox"] = raw([]contracts.RawObject{intent})
			case "negative-time":
				intent["at"] = raw(-1)
				value["outbox"] = raw([]contracts.RawObject{intent})
			case "unknown-status":
				intent["status"] = raw("future-state")
				value["outbox"] = raw([]contracts.RawObject{intent})
			}
			data := raw(value)
			if scenario == "non-object" {
				data = []byte(`[]`)
			} else if scenario == "huge" {
				data = bytes.Repeat([]byte(" "), MaxConfigBytes+1)
			}
			if !errors.Is(ValidateBackupConfig(data), ErrConfig) {
				t.Fatal("invalid restored configuration was accepted")
			}
		})
	}
}

type interruptedMirrorPersistence struct {
	Persistence
	calls  int
	failAt int
}

func (value *interruptedMirrorPersistence) Mutate(ctx context.Context, operation func(*contracts.State) error) error {
	value.calls++
	if value.calls == value.failAt {
		return errors.New("isolated persistence interruption")
	}
	return value.Persistence.Mutate(ctx, operation)
}

func TestMirrorSchedulingPersistenceInterruptionNeverReplaysAPossiblyPublishedBatch(t *testing.T) {
	fixture := fixture(t)
	message := fixture.add(t, contracts.RoleAssistant, "isolated reply with interrupted final scheduling receipt")
	interrupted := &interruptedMirrorPersistence{Persistence: fixture.Store, failAt: 2}
	fixture.Gateway.options.Store = interrupted
	if err := fixture.Gateway.Scan(t.Context()); err == nil || fixture.Sent.Load() != 0 {
		t.Fatal("interrupted scheduling was reported as committed or sent synchronously")
	}
	fixture.Gateway.options.Store = fixture.Store
	fixture.Now.Add(2)
	fixture.flush(t)
	marker := mirrorOf(messageByID(fixture.Store.Snapshot(), message.ID))
	if marker.Text == nil || *marker.Text != MirrorUnknown || fixture.Sent.Load() != 0 || fixture.Gateway.config.Outbox[0].Status != OutboxFailed {
		t.Fatal("partially persisted scheduling was retried instead of retained as unknown")
	}
}

func TestLegacyEmptyTurnAliasSurvivesDiskReopenWithoutHidingUnsubmittedPausedMessages(t *testing.T) {
	fixture := fixture(t)
	message := fixture.add(t, contracts.RoleUser, "isolated unsubmitted paused request")
	if _, err := fixture.Store.Update(t.Context(), message.ID, contracts.MessagePatch{"status": raw(contracts.TaskStatusPaused)}); err != nil {
		t.Fatal(err)
	}
	if err := fixture.Store.Mutate(t.Context(), func(state *contracts.State) error {
		state.WorkTasks = []contracts.WorkRecord{{
			ID: "00000000-0000-4000-8000-000000000091", TurnID: "legacy-turn", TurnIDs: []string{"", "legacy-turn"},
			Source: "voice", Title: "isolated legacy completed work", Status: contracts.WorkStatusCompleted,
			StartedAt: 1000, UpdatedAt: 2000,
			Plan: &contracts.TaskPlan{Steps: []contracts.PlanStep{{Step: "isolated verified step", Status: contracts.PlanStepStatusCompleted}}},
		}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	fixture.Store.Close()
	reopened, err := store.OpenContext(t.Context(), filepath.Join(fixture.Directory, "state"), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reopened.Close)
	fixture.Gateway.options.Store = reopened
	state := reopened.Snapshot()
	if len(state.WorkTasks) != 1 || len(state.WorkTasks[0].TurnIDs) != 2 || state.WorkTasks[0].TurnIDs[0] != "" || state.Messages[0].TurnID.Present {
		t.Fatal("supported legacy fixture was not preserved with its omitted message turn identity")
	}
	before := raw(state)
	text := fixture.Gateway.ProgressText(false)
	if !strings.Contains(text, "isolated unsubmitted paused request") || !strings.Contains(text, "/resume "+message.ID) || !bytes.Equal(before, raw(reopened.Snapshot())) {
		t.Fatal("empty legacy alias hid unrelated paused work or changed its stored identity")
	}
}

func TestGatewayRefusesNonRegularConfigurationAndNonDirectoryStorage(t *testing.T) {
	fixture := fixture(t)
	for _, scenario := range []string{"configuration-directory", "storage-file"} {
		t.Run(scenario, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "telegram-storage")
			if scenario == "storage-file" {
				if err := os.WriteFile(directory, []byte("isolated"), 0600); err != nil {
					t.Fatal(err)
				}
			} else if err := os.MkdirAll(filepath.Join(directory, "telegram.json"), 0700); err != nil {
				t.Fatal(err)
			}
			if gateway, err := Open(t.Context(), directory, fixture.Gateway.options); !errors.Is(err, ErrConfig) || gateway != nil {
				t.Fatal("gateway silently replaced an invalid storage boundary")
			}
		})
	}
}
