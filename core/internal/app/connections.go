package app

import (
	"context"

	"github.com/Stephen-Sim/dant/core/internal/httpapi"
)

// Connection changes reserve admission while their RPC runs outside the actor.
// An inherited uncertain stop needs independent process proof before any new
// executor can be launched; creating a fresh LocalWorker is not that proof.
func (app *WorkerApp) connectionOperation(ctx context.Context, requireEmptyQueue bool, operation func(context.Context) error) error {
	if app.engine.UnconfirmedStop() {
		return httpapi.Failure(409, "executor_stop_unconfirmed", "The previous executor stop could not be confirmed. Verify that it stopped before reconnecting.")
	}
	return conversationRouteError(app.engine.ConnectionTransaction(ctx, requireEmptyQueue, operation))
}
