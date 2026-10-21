package controller

import (
	"context"
	"errors"
	"testing"
)

type deploymentBridgeFixture struct {
	Bridge
	calls  int
	result error
}

func (bridge *deploymentBridgeFixture) Prepare(context.Context) error {
	bridge.calls++
	return bridge.result
}

func TestExplicitDeploymentOnlyPreparesTheVerifiedWorkerBundle(t *testing.T) {
	for _, failure := range []error{nil, errors.New("fixture_update_unconfirmed")} {
		t.Run("one-shot", func(t *testing.T) {
			app, original, _, _ := controllerAppFixture(t)
			bridge := &deploymentBridgeFixture{Bridge: original, result: failure}
			app.bridge = bridge

			if err := app.DeployWorker(context.Background()); !errors.Is(err, failure) {
				t.Fatal(err)
			}
			if bridge.calls != 1 || original.connects != 0 || original.pauses != 0 || app.started {
				t.Fatal("one-shot deployment connected an executor or enabled automatic work")
			}
		})
	}
}
