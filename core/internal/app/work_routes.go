package app

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/httpapi"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/work"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const screenResponseBytes = 32 * 1024 * 1024

type progressResumeResult struct {
	WorkRecord *contracts.WorkRecord
}

func (result progressResumeResult) MarshalJSON() ([]byte, error) {
	encoded, err := json.Marshal(result.WorkRecord)
	if err != nil {
		return nil, err
	}
	var fields contracts.RawObject
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	fields["resumed"] = json.RawMessage("true")
	return json.Marshal(fields)
}

func progressBody(writer http.ResponseWriter, request *http.Request) (contracts.RawObject, error) {
	return httpapi.ReadObject(writer, request, 0)
}

func progressKind(body contracts.RawObject) (store.ProgressKind, error) {
	kind, err := httpapi.String(body, "kind", true)
	if err != nil || !store.ProgressKind(kind).Valid() {
		return "", httpapi.Failure(400, "invalid_progress_kind", "Invalid work progress entry.")
	}
	return store.ProgressKind(kind), nil
}

func optionalProgressID(body contracts.RawObject, name string, required bool) (contracts.Optional[string], error) {
	raw, present := body[name]
	if !present {
		if required {
			return contracts.Optional[string]{}, httpapi.Failure(400, "progress_identity_required", "A current progress identity is required.")
		}
		return contracts.Optional[string]{}, nil
	}
	var result contracts.Optional[string]
	if !contracts.ValidUnicodeJSON(raw) || json.Unmarshal(raw, &result) != nil || !result.Null && !workstate.ValidID(result.Value, workstate.ReferenceIDLength) {
		return result, httpapi.Failure(400, "invalid_progress_identity", "Invalid work progress identity.")
	}
	return result, nil
}

func registerWorkRoutes(mux *http.ServeMux, app *WorkerApp) {
	for _, route := range []string{"POST /api/stop", "POST /api/tasks/pause"} {
		httpapi.Register(mux, route, func(writer http.ResponseWriter, request *http.Request) error {
			if err := app.engine.Pause(request.Context()); err != nil {
				return conversationRouteError(err)
			}
			app.change()
			return httpapi.JSON(writer, map[string]bool{"ok": true})
		})
	}
	httpapi.Register(mux, "POST /api/retry/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := progressBody(writer, request)
		if err != nil {
			return err
		}
		message, err := app.store.Message(request.PathValue("id"))
		if err != nil || message.Role != contracts.RoleUser || message.Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) && message.Status.Value != contracts.MessageStatus(contracts.TaskStatusFailed) {
			return httpapi.Failure(409, "retry_unavailable", "This message cannot be retried.")
		}
		confirm, err := httpapi.Boolean(body, "confirmUnknown", false)
		if err != nil {
			return err
		}
		if _, err := app.engine.ResumePaused(request.Context(), []string{message.ID}, work.ResumeOptions{ConfirmUnknown: confirm}); err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, map[string]bool{"ok": true})
	})
	httpapi.Register(mux, "POST /api/tasks/resume", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := progressBody(writer, request)
		if err != nil {
			return err
		}
		ids, err := routeStrings(body["ids"], 100)
		if err != nil {
			return err
		}
		confirm, err := httpapi.Boolean(body, "confirmUnknown", false)
		if err != nil {
			return err
		}
		if _, err := app.engine.ResumePaused(request.Context(), ids, work.ResumeOptions{ConfirmUnknown: confirm}); err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, map[string]bool{"ok": true})
	})
	httpapi.Register(mux, "POST /api/tasks/{id}/accept", func(writer http.ResponseWriter, request *http.Request) error {
		result, err := app.engine.Confirm(request.Context(), request.PathValue("id"))
		if err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, result)
	})
	for _, operation := range []string{"pause", "cancel"} {
		httpapi.Register(mux, "POST /api/tasks/{id}/"+operation, func(writer http.ResponseWriter, request *http.Request) error {
			body, err := progressBody(writer, request)
			if err != nil {
				return err
			}
			kind, err := httpapi.String(body, "kind", true)
			if err != nil || kind != "task" && kind != "work" && kind != "active" || kind == "active" && request.PathValue("id") != "current" {
				return httpapi.Failure(400, "invalid_progress_kind", "Invalid work progress entry.")
			}
			turn, err := optionalProgressID(body, "turnId", true)
			if err != nil {
				return err
			}
			call, err := optionalProgressID(body, "callId", false)
			if err != nil {
				return err
			}
			conversation, err := routeConversation(body, app.store.ConversationID())
			if err != nil {
				return err
			}
			result, err := app.engine.CancelProgress(request.Context(), work.ProgressTarget{ID: request.PathValue("id"), Kind: kind, TurnID: turn, CallID: call, ConversationID: conversation}, operation == "pause")
			if err != nil {
				return conversationRouteError(err)
			}
			app.change()
			return httpapi.JSON(writer, result)
		})
	}
	httpapi.Register(mux, "POST /api/tasks/{id}/resume", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := progressBody(writer, request)
		if err != nil {
			return err
		}
		kind, err := progressKind(body)
		if err != nil {
			return err
		}
		turn, err := optionalProgressID(body, "turnId", true)
		if err != nil || turn.Null {
			return httpapi.Failure(409, "resume_unavailable", "Choose the paused task again.")
		}
		conversation, err := routeConversation(body, app.store.ConversationID())
		if err != nil {
			return err
		}
		result, err := app.engine.ResumeProgressForConversation(request.Context(), conversation, request.PathValue("id"), kind, turn.Value)
		if err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, progressResumeResult{WorkRecord: result})
	})
	httpapi.Register(mux, "POST /api/tasks/clear-completed", func(writer http.ResponseWriter, request *http.Request) error {
		count, err := app.engine.ClearCompletedProgress(request.Context())
		if err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, map[string]int{"cleared": count})
	})
	httpapi.Register(mux, "POST /api/tasks/{id}/priority", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := progressBody(writer, request)
		if err != nil {
			return err
		}
		kind, err := progressKind(body)
		if err != nil {
			return err
		}
		var priority contracts.TaskPriority
		if json.Unmarshal(body["priority"], &priority) != nil {
			return httpapi.Failure(400, "invalid_priority", "Invalid task priority.")
		}
		if err := app.engine.SetProgressPriority(request.Context(), request.PathValue("id"), kind, priority); err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, map[string]bool{"ok": true})
	})
	httpapi.Register(mux, "POST /api/tasks/{id}/dismiss", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := progressBody(writer, request)
		if err != nil {
			return err
		}
		kind, err := progressKind(body)
		if err != nil {
			return err
		}
		confirm, err := httpapi.Boolean(body, "confirmUnfinished", false)
		if err != nil {
			return err
		}
		turn, err := optionalProgressID(body, "expectedTurnId", false)
		if err != nil {
			return err
		}
		conversation, err := optionalProgressID(body, "expectedConversationId", false)
		if err != nil {
			return err
		}
		if err := app.engine.DismissProgress(request.Context(), request.PathValue("id"), kind, store.DismissOptions{ConfirmUnfinished: confirm, ExpectedTurnID: turn, ExpectedConversationID: conversation}); err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, map[string]bool{"ok": true})
	})
	httpapi.Register(mux, "GET /api/tasks/{id}/context", app.taskContext)
	mux.HandleFunc("/api/tasks/{id}/context", func(writer http.ResponseWriter, _ *http.Request) {
		httpapi.WriteError(writer, httpapi.Failure(405, "read_only", "Task context is read-only."))
	})
	httpapi.Register(mux, "POST /api/steer", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := progressBody(writer, request)
		if err != nil {
			return err
		}
		text, err := httpapi.String(body, "text", true)
		if err != nil {
			return err
		}
		turn, err := httpapi.String(body, "expectedTurnId", true)
		if err != nil || !contracts.ValidUnicodeJSON(body["expectedTurnId"]) {
			return httpapi.Failure(400, "invalid_turn", "Choose the current task again.")
		}
		reply, err := optionalProgressID(body, "replyTo", false)
		if err != nil {
			return err
		}
		conversation, err := routeConversation(body, app.store.ConversationID())
		if err != nil {
			return err
		}
		result, err := app.engine.Steer(request.Context(), conversation, turn, text, reply.Value)
		if err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "POST /api/takeover", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := progressBody(writer, request)
		if err != nil {
			return err
		}
		enabled, err := httpapi.Boolean(body, "enabled", false)
		if err != nil {
			return err
		}
		var result computer.Control
		if enabled {
			result, err = app.computer.Acquire(request.Context())
		} else {
			session, failure := httpapi.String(body, "sessionId", true)
			if failure != nil {
				return failure
			}
			result, err = app.computer.Release(request.Context(), session)
		}
		if err != nil {
			return httpapi.Failure(409, "computer_control_unconfirmed", "Desktop control could not be confirmed.")
		}
		response, err := contracts.DecodeObject(encode(result), len(encode(result)))
		if err != nil {
			return err
		}
		response["ok"] = encode(true)
		app.change()
		return httpapi.JSON(writer, response)
	})
	httpapi.Register(mux, "GET /api/screen", func(writer http.ResponseWriter, request *http.Request) error {
		response, err := app.worker.Guest(request.Context(), "/screen", nil)
		if err != nil {
			return conversationRouteError(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, screenResponseBytes+1))
		if err != nil || len(data) > screenResponseBytes {
			return httpapi.Failure(502, "screen_unavailable", "The work computer screen could not be read.")
		}
		writer.Header().Set("Content-Type", "image/png")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Cache-Control", "no-store")
		_, err = writer.Write(data)
		return err
	})
	httpapi.Register(mux, "POST /api/input", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := progressBody(writer, request)
		if err != nil {
			return err
		}
		result, err := app.computer.Input(request.Context(), encode(body))
		if err != nil {
			return httpapi.Failure(409, "computer_control_unconfirmed", "Desktop input could not be confirmed.")
		}
		return httpapi.JSON(writer, result)
	})
}

func (app *WorkerApp) taskContext(writer http.ResponseWriter, request *http.Request) error {
	writer.Header().Set("Cache-Control", "no-store")
	conversation, turn := request.URL.Query().Get("conversationId"), request.URL.Query().Get("turnId")
	project, err := app.engine.TaskContext(request.Context(), request.PathValue("id"), conversation, turn)
	if err != nil {
		return conversationRouteError(err)
	}
	state := app.store.Snapshot()
	record, err := store.FindWork(&state, request.PathValue("id"))
	if err != nil || state.ConversationID != conversation || record.TurnID != turn {
		return httpapi.Failure(409, "task_changed", "The task changed. Choose it again.")
	}
	steps := json.RawMessage("null")
	if record.Plan != nil {
		projected := make([]contracts.PlanStep, len(record.Plan.Steps))
		for index, step := range record.Plan.Steps {
			projected[index] = step
			projected[index].Step = app.redact(step.Step)
		}
		steps = encode(struct {
			Steps []contracts.PlanStep `json:"steps"`
		}{projected})
	}
	return httpapi.JSON(writer, contracts.RawObject{"workId": encode(record.ID), "turnId": encode(turn), "conversationId": encode(conversation), "title": encode(app.redact(record.Title)), "status": encode(record.Status), "plan": steps, "projectContext": project, "referenceDataOnly": encode(true)})
}
