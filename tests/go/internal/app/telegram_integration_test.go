package app

import (
	"encoding/json"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/telegram"
)

func TestWorkerTelegramStopOnlyTargetsExactlyPairedActiveInput(t *testing.T) {
	app, _, owner := acknowledgedToolFixture(t)
	paired := telegram.Owner{PairingID: "fixture-pair", ChatID: "100", UserID: "200"}
	bot := telegram.Bot{ID: "300"}
	source := contracts.RawObject{
		"type": encode("telegram"), "pairingId": encode(paired.PairingID),
		"chatId": encode(paired.ChatID), "userId": encode(paired.UserID), "botId": encode(bot.ID),
	}
	if _, err := app.store.Update(t.Context(), owner.MessageID, contracts.MessagePatch{"source": encode(source)}); err != nil {
		t.Fatal(err)
	}
	state := app.telegramWork()
	if !state.Online || state.Active == nil || state.Active.TurnID.Value != owner.TurnID {
		t.Fatal("Telegram projection lost active executor authority")
	}
	for _, key := range []string{"type", "pairingId", "chatId", "userId", "botId"} {
		for _, invalid := range []json.RawMessage{encode("unrelated"), encode(false), encode("")} {
			changed := make(contracts.RawObject, len(source))
			for name, value := range source {
				changed[name] = value
			}
			changed[key] = invalid
			if sameTelegramOwner(changed, paired, bot) {
				t.Fatal("Telegram ownership accepted a foreign or malformed component")
			}
		}
	}
	if sameTelegramOwner(source, telegram.Owner{}, bot) || sameTelegramOwner(source, paired, telegram.Bot{}) {
		t.Fatal("missing pairing component was treated as owned")
	}
	wrongPair := paired
	wrongPair.PairingID = "replacement-pair"
	stopped, err := app.stopTelegramWork(t.Context(), wrongPair, bot)
	if err != nil || stopped || app.engine.Snapshot().Active == nil {
		t.Fatal("foreign Telegram pair cancelled active work")
	}
	stopped, err = app.stopTelegramWork(t.Context(), paired, bot)
	if err != nil || !stopped {
		t.Fatal("current Telegram pair could not stop its acknowledged work", err)
	}
}

func TestWorkerTelegramDoesNotStopChatOrIdleWorkAndNeverCreatesSecondInputOnStaleScope(t *testing.T) {
	app := fixtureWorker(t)
	owner := telegram.Owner{PairingID: "fixture", ChatID: "100", UserID: "200"}
	bot := telegram.Bot{ID: "300"}
	if stopped, err := app.stopTelegramWork(t.Context(), owner, bot); stopped || err != nil {
		t.Fatal("idle Telegram stop changed executor state")
	}
	if err := app.admitTelegram(t.Context(), "old-conversation", &contracts.ChatMessage{Role: contracts.RoleUser, Text: "stale Telegram input"}); err == nil {
		t.Fatal("stale Telegram scope admitted input")
	}
	if len(app.store.Snapshot().Messages) != 0 {
		t.Fatal("rejected external input was persisted")
	}
	active, _, scope := acknowledgedToolFixture(t)
	before := active.store.Revision()
	if stopped, err := active.stopTelegramWork(t.Context(), owner, bot); stopped || err != nil {
		t.Fatal("Telegram cancelled an ordinary chat task")
	}
	if active.store.Revision() != before || !active.engine.Current(scope) {
		t.Fatal("foreign cancellation changed durable authority")
	}
}
