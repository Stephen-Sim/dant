package controller

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type retiringObservationBridge struct {
	*controllerBridgeFixture
	reads int
}

func (bridge *retiringObservationBridge) Generation() uint64 {
	bridge.reads++
	if bridge.reads == 2 {
		bridge.controllerBridgeFixture.Disconnect()
	}
	return bridge.controllerBridgeFixture.Generation()
}

func TestControllerRetiredObservationCannotReplaceCurrentConversation(t *testing.T) {
	app, existing, _, _ := controllerAppFixture(t)
	app.mu.Lock()
	before, err := json.Marshal(app.cached)
	app.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	state := emptyWorkerSnapshot()
	state.ConversationID = "retired-observation"
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	bridge := &retiringObservationBridge{controllerBridgeFixture: existing}
	app.bridge = bridge
	app.observe(computer.BridgeEvent{Generation: 0, Type: "state", Data: raw})
	app.mu.Lock()
	after, err := json.Marshal(app.cached)
	app.mu.Unlock()
	if err != nil || string(before) != string(after) || bridge.reads != 2 {
		t.Fatal("generation changed during observation but its obsolete state was applied", err)
	}
	if len(app.cacheWake) != 0 {
		t.Fatal("retired observation entered the cache persistence queue")
	}
}

func TestControllerRetiredDesktopCoordinatorStopsInstallationPreparation(t *testing.T) {
	app, bridge, power, _ := controllerOperationsFixture(t)
	bridge.status = contracts.ConnectionStatusOnline
	app.desktop.Close()
	if err := app.prepareInstallation(t.Context()); !errors.Is(err, ErrDesktopBusy) {
		t.Fatal("retired coordinator reported confirmed installation preparation", err)
	}
	if power.resumed != 0 || power.suspended != 0 || bridge.connects != 0 || bridge.pauses != 0 {
		t.Fatal("retired installation preparation crossed a connection or power boundary")
	}
}
