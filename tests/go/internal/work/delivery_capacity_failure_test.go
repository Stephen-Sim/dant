package work

import (
	"errors"
	"fmt"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

func TestObservedOutputAndCompletedIdentityBudgetsKeepTheMostRecentOwnedEntries(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "bounded-output-owner")
	engine.mu.Lock()
	active := engine.active
	for index := range workstate.ObservedItems {
		id := fmt.Sprintf("observed-%d", index)
		if engine.boundOutput(active, id, "x") != "x" {
			engine.mu.Unlock()
			t.Fatal("valid bounded output was unexpectedly discarded")
		}
	}
	if engine.boundOutput(active, "overflow", "unadmitted content") != "" || len(active.outputs) != workstate.ObservedItems || len(active.outputOrder) != workstate.ObservedItems || engine.boundOutput(active, "observed-0", "updated") != "updated" {
		engine.mu.Unlock()
		t.Fatal("output overflow replaced an admitted item or prevented its existing owner updating it")
	}
	engine.mu.Unlock()
	ids := []string{}
	for index := range MaxCompletedIDs + 1 {
		ids = boundedID(ids, fmt.Sprintf("completed-%d", index))
	}
	if len(ids) != MaxCompletedIDs || ids[0] != "completed-1" || ids[len(ids)-1] != fmt.Sprintf("completed-%d", MaxCompletedIDs) || !owner.IsCurrent() {
		t.Fatal("completed identity retention lost its most recent idempotency evidence")
	}
	assertWorkerQuiet(t, worker)
}

func TestMCPReceiptCapacityAndInvalidReactionNeverPublishUnverifiedDelivery(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	message, owner := beginBehaviorTurn(t, engine, persistence, worker, "mcp-capacity-owner")
	invalid := contracts.RawObject{"messageId": raw(message.ID), "emoji": raw("not-a-supported-reaction")}
	reaction := mcpBehaviorItem("invalid-identical-reaction", "react_message", invalid, contracts.RawObject{"dantReaction": raw(invalid)})
	if err := engine.Handle(t.Context(), mcpBehaviorEvent(owner, reaction)); err != nil {
		t.Fatal(err)
	}
	stored, err := persistence.Message(message.ID)
	if err != nil || stored.AssistantReaction.Present {
		t.Fatal("matching but invalid reaction receipts altered chat", err)
	}
	for index := range 128 {
		item := mcpBehaviorItem(
			fmt.Sprintf("receipt-%d", index), "send_chat_message",
			contracts.RawObject{"text": raw("One deduplicated verified result")},
			contracts.RawObject{"dantMessage": raw(contracts.RawObject{"text": raw("One deduplicated verified result")})},
		)
		if err := engine.Handle(t.Context(), mcpBehaviorEvent(owner, item)); err != nil {
			t.Fatal("valid bounded MCP receipt was not recorded", err)
		}
	}
	before := persistence.Revision()
	item := mcpBehaviorItem(
		"overflow-receipt", "send_chat_message",
		contracts.RawObject{"text": raw("Unadmitted overflow result")},
		contracts.RawObject{"dantMessage": raw(contracts.RawObject{"text": raw("Unadmitted overflow result")})},
	)
	if err := engine.Handle(t.Context(), mcpBehaviorEvent(owner, item)); !errors.Is(err, runtime.ErrBackpressure) || persistence.Revision() != before || len(persistence.Snapshot().Messages) != 2 || !owner.IsCurrent() {
		t.Fatal("receipt overflow published an untracked side effect or replaced its owner", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestMCPReceiptRechecksOwnershipAfterTheExternalCapabilityCheck(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	_, owner := beginBehaviorTurn(t, engine, persistence, worker, "mcp-check-retirement")
	engine.mu.Lock()
	active := engine.active
	engine.mu.Unlock()
	owner.IsCurrent = func() bool {
		if err := engine.Handle(t.Context(), terminal(owner.TurnID, "completed")); err != nil {
			t.Fatal(err)
		}
		return true
	}
	item := mcpBehaviorItem(
		"late-receipt", "send_chat_message",
		contracts.RawObject{"text": raw("Late result")},
		contracts.RawObject{"dantMessage": raw(contracts.RawObject{"text": raw("Late result")})},
	)
	if err := engine.acceptMCPResult(t.Context(), active, item, owner); !errors.Is(err, ErrStaleOwner) || len(persistence.Snapshot().Messages) != 1 || engine.Snapshot().Active != nil {
		t.Fatal("capability that expired during validation published after its turn ended", err)
	}
	assertWorkerQuiet(t, worker)
}
