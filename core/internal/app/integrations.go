package app

import (
	"context"
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/telegram"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func (app *WorkerApp) telegramWork() telegram.WorkState {
	state := app.engine.Snapshot()
	return telegram.WorkState{
		Online: app.online(), Takeover: state.Takeover, Acquiring: state.Acquiring,
		Call: state.Call, Active: state.Active, Queue: state.Queue,
		Pending: state.Finishing || len(state.PendingFollowups) > 0 || app.calls.PendingWork(),
	}
}

func (app *WorkerApp) admitTelegram(ctx context.Context, conversationID string, message *contracts.ChatMessage) error {
	return app.engine.AdmitExternalMessage(ctx, conversationID, message)
}

func sameTelegramOwner(source contracts.RawObject, owner telegram.Owner, bot telegram.Bot) bool {
	values := map[string]string{
		"type": "telegram", "pairingId": owner.PairingID,
		"botId": bot.ID, "chatId": owner.ChatID, "userId": owner.UserID,
	}
	for key, expected := range values {
		var actual string
		if expected == "" || json.Unmarshal(source[key], &actual) != nil || actual != expected {
			return false
		}
	}
	return true
}

func (app *WorkerApp) stopTelegramWork(ctx context.Context, owner telegram.Owner, bot telegram.Bot) (bool, error) {
	state, execution := app.engine.StateSnapshot()
	if execution.Active == nil || execution.Takeover || execution.Acquiring {
		return false, nil
	}
	active := execution.Active
	if len(active.MessageIDs) == 0 {
		return false, nil
	}
	for _, id := range active.MessageIDs {
		message, err := store.FindMessage(&state, id)
		if err != nil || !sameTelegramOwner(message.Source, owner, bot) {
			return false, nil
		}
	}
	_, err := app.engine.CancelProgress(ctx, work.ProgressTarget{
		ID: active.MessageID.Value, Kind: "active", TurnID: active.TurnID,
		ConversationID: state.ConversationID,
	}, false)
	return err == nil, err
}
