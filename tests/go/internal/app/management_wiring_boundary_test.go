package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestWorkerSkillManagementReloadsReferencesWithoutExecutingAChatTurn(t *testing.T) {
	app := fixtureWorker(t)
	response := callWorker(app, http.MethodPost, "/api/skills", `{"name":"isolated-skill","description":"isolated description","instructions":"Reference only; do not execute a helper."}`)
	requireWorkerStatus(t, response, http.StatusOK)
	view, err := app.skills.Get(t.Context(), "isolated-skill")
	if err != nil || view.Instructions != "Reference only; do not execute a helper." {
		t.Fatal("skill management did not retain its persisted contents", err)
	}
	requireWorkerStatus(t, callWorker(app, http.MethodPatch, "/api/skills/isolated-skill", `{"enabled":false}`), http.StatusOK)
	requireWorkerStatus(t, callWorker(app, http.MethodDelete, "/api/skills/isolated-skill", ""), http.StatusOK)
	if len(app.store.Snapshot().Messages) != 0 || len(app.engine.Snapshot().Queue) != 0 || app.worker.Snapshot().Status != contracts.ConnectionStatusOffline {
		t.Fatal("reference refresh started execution or created a chat input")
	}
}

func TestWorkerCredentialBridgeToolFailureNeverInventsAConfirmedResult(t *testing.T) {
	app, wire, _ := acknowledgedToolFixture(t)
	before := app.store.Revision()
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:4317/api/internal/credentials", strings.NewReader(`{"tool":"credential_get","arguments":{"id":"117447a5-40c1-4b7c-b117-a719546306db"}}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Dant-Credential-Token", app.credentialToken)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), `"code":"operation_failed"`) || strings.Contains(response.Body.String(), app.options.Startup.DataDir) || app.store.Revision() != before || wire.count("turn/start") != 1 {
		t.Fatal("failed credential read leaked storage details, replayed work or mutated ownership")
	}
}
