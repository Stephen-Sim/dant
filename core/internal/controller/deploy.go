package controller

import "context"

// DeployWorker performs the explicit one-shot CLI deployment. It does not start
// automatic connection monitoring, create an Engine, or open a model session.
func (app *App) DeployWorker(ctx context.Context) error {
	return app.prepareConnection(ctx)
}
