package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/history"
	"github.com/Stephen-Sim/dant/core/internal/httpapi"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/store"
	"github.com/Stephen-Sim/dant/core/internal/voice"
	"github.com/Stephen-Sim/dant/core/internal/work"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const visibleReceiptLimit = 1000

var receiptFileID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func conversationRouteError(err error) error {
	if err == nil {
		return nil
	}
	var api *contracts.APIError
	var uncertain *runtime.OperationError
	if errors.As(err, &api) || errors.As(err, &uncertain) {
		return err
	}
	switch {
	case errors.Is(err, store.ErrInvalidState):
		return httpapi.Failure(400, "invalid_message", "Invalid message request.")
	case errors.Is(err, store.ErrMessageNotFound):
		return httpapi.Failure(404, "message_not_found", "Message not found.")
	case errors.Is(err, work.ErrStaleOwner), errors.Is(err, work.ErrBusy), errors.Is(err, work.ErrPaused), errors.Is(err, work.ErrUnknown), errors.Is(err, work.ErrClosed), errors.Is(err, runtime.ErrDisconnected), errors.Is(err, runtime.ErrBackpressure):
		return httpapi.Failure(409, "conversation_unavailable", "The conversation or executor changed. Refresh its current status before trying again.")
	default:
		return err
	}
}

func routeFields(body contracts.RawObject, allowed ...string) error {
	for key := range body {
		if !slices.Contains(allowed, key) {
			return httpapi.Failure(400, "invalid_request", "Invalid request fields.")
		}
	}
	return nil
}

func routeStrings(raw json.RawMessage, limit int) ([]string, error) {
	var values []json.RawMessage
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &values) != nil || values == nil || len(values) > limit {
		return nil, httpapi.Failure(400, "invalid_request", "Invalid request fields.")
	}
	result := make([]string, 0, len(values))
	for _, item := range values {
		var value string
		if !contracts.ValidUnicodeJSON(item) || json.Unmarshal(item, &value) != nil {
			return nil, httpapi.Failure(400, "invalid_request", "Invalid request fields.")
		}
		result = append(result, value)
	}
	return result, nil
}

func routeConversation(body contracts.RawObject, current string) (string, error) {
	if value, present := body["conversationId"]; present {
		var id string
		if !contracts.ValidUnicodeJSON(value) || json.Unmarshal(value, &id) != nil || id != current {
			return "", httpapi.Failure(409, "conversation_changed", "The conversation changed.")
		}
	}
	return current, nil
}

func registerConversationRoutes(mux *http.ServeMux, app *WorkerApp) {
	service := history.New(app.store, app.engine.HistoryTransaction)
	httpapi.Register(mux, "PATCH /api/messages/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		if err := routeFields(body, "text", "resubmit"); err != nil {
			return err
		}
		text, err := httpapi.String(body, "text", true)
		if err != nil {
			return err
		}
		resubmit, err := httpapi.Boolean(body, "resubmit", false)
		if err != nil {
			return err
		}
		result, err := service.Edit(request.Context(), request.PathValue("id"), text, resubmit)
		if err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "PATCH /api/messages/{id}/metadata", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		result, err := service.SetMetadata(request.Context(), request.PathValue("id"), body)
		if err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "DELETE /api/messages/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		result, err := service.Remove(request.Context(), request.PathValue("id"))
		if err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "DELETE /api/history", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		confirm, err := httpapi.Boolean(body, "confirm", false)
		if err != nil {
			return err
		}
		result, err := service.Clear(request.Context(), confirm)
		if err != nil {
			return conversationRouteError(err)
		}
		app.change()
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "POST /api/messages", app.receiveMessage)
	httpapi.Register(mux, "POST /api/read", app.receiveVisible)
	httpapi.Register(mux, "POST /api/messages/{id}/reaction", func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		emoji, err := httpapi.String(body, "emoji", true)
		if err != nil {
			return err
		}
		conversationID, err := routeConversation(body, app.store.ConversationID())
		if err != nil {
			return err
		}
		call := app.calls.Snapshot()
		if _, err := service.ToggleReaction(request.Context(), request.PathValue("id"), conversationID, emoji); err != nil {
			return conversationRouteError(err)
		}
		result := contracts.RawObject{"ok": encode(true)}
		if call != nil && app.store.ConversationID() == conversationID {
			message, err := app.store.Message(request.PathValue("id"))
			if err == nil {
				result["voiceContext"] = encode(app.calls.SyncContext(request.Context(), call.ID, "reaction", message))
			}
		}
		app.change()
		return httpapi.JSON(writer, result)
	})
}

func (app *WorkerApp) receiveMessage(writer http.ResponseWriter, request *http.Request) error {
	body, err := httpapi.ReadObject(writer, request, 0)
	if err != nil {
		return err
	}
	if err := routeFields(body, "text", "replyTo", "attachments", "clientMessageId", "workReply", "conversationId"); err != nil {
		return err
	}
	conversationID, err := routeConversation(body, app.store.ConversationID())
	if err != nil {
		return err
	}
	fields := contracts.RawObject{"role": encode(contracts.RoleUser), "text": encode("")}
	for _, name := range []string{"text", "replyTo", "clientMessageId"} {
		if raw, present := body[name]; present {
			fields[name] = raw
		}
	}
	for _, name := range []string{"replyTo", "clientMessageId"} {
		if raw, present := fields[name]; present && !contracts.ValidUnicodeJSON(raw) {
			return httpapi.Failure(400, "invalid_message", "Invalid message request.")
		}
	}
	if raw, present := body["workReply"]; present {
		target, err := contracts.DecodeObject(raw, len(raw))
		if err != nil || routeFields(target, "workId", "turnId", "conversationId") != nil {
			return httpapi.Failure(409, "work_reply_unavailable", "The selected task changed.")
		}
		for _, name := range []string{"workId", "turnId", "conversationId"} {
			var id string
			if !contracts.ValidUnicodeJSON(target[name]) || json.Unmarshal(target[name], &id) != nil || !workstate.ValidID(id, workstate.ReferenceIDLength) {
				return httpapi.Failure(409, "work_reply_unavailable", "The selected task changed.")
			}
		}
		fields["workReply"] = raw
	}
	var message contracts.ChatMessage
	if encoded, present := body["clientMessageId"]; present && bytes.Equal(bytes.TrimSpace(encoded), []byte("null")) {
		return httpapi.Failure(400, "invalid_message", "Invalid message request.")
	}
	if json.Unmarshal(encode(fields), &message) != nil {
		return httpapi.Failure(400, "invalid_message", "Invalid message request.")
	}
	ids := []string{}
	if raw, present := body["attachments"]; present {
		ids, err = routeStrings(raw, work.MaxDeliveredFiles)
		if err != nil {
			return err
		}
	}
	var prior *contracts.ChatMessage
	if message.ClientMessageID != "" {
		for _, candidate := range app.store.Snapshot().Messages {
			if candidate.Role == contracts.RoleUser && candidate.ClientMessageID == message.ClientMessageID {
				prior = candidate
				break
			}
		}
	}
	for index, id := range ids {
		if id == "" || slices.Contains(ids[:index], id) {
			return httpapi.Failure(400, "invalid_attachment", "Attach at most five distinct saved files.")
		}
		if prior != nil && index < len(prior.Attachments) && prior.Attachments[index].ID == id {
			message.Attachments = append(message.Attachments, prior.Attachments[index])
			continue
		}
		file, _, err := app.attachments.Read(request.Context(), id)
		if err != nil {
			return httpapi.Failure(400, "attachment_not_found", "Attachment not found; upload it again.")
		}
		message.Attachments = append(message.Attachments, file)
	}
	receipt, err := app.engine.AdmitMessage(request.Context(), conversationID, &message)
	if err != nil {
		return conversationRouteError(err)
	}
	app.change()
	if receipt.Existing {
		return httpapi.JSON(writer, receipt.Message)
	}
	if receipt.CallID != "" {
		if err := app.submitCallMessage(request.Context(), conversationID, receipt); err != nil {
			return conversationRouteError(err)
		}
	} else if receipt.ContextCallID != "" && receipt.ContextProvider == "api" && len(message.Attachments) > 0 {
		_ = app.calls.SyncContext(request.Context(), receipt.ContextCallID, "message", receipt.Message)
	}
	saved, err := app.store.Message(receipt.Message.ID)
	if err != nil {
		return conversationRouteError(err)
	}
	return httpapi.JSON(writer, saved)
}

func (app *WorkerApp) submitCallMessage(requestContext context.Context, conversationID string, receipt work.AdmissionReceipt) error {
	message := receipt.Message
	if message == nil {
		return store.ErrInvalidState
	}
	app.lifecycle.Lock()
	if app.closed {
		app.lifecycle.Unlock()
		return work.ErrClosed
	}
	app.operations.Add(1)
	app.lifecycle.Unlock()
	result := make(chan error, 1)
	go func() {
		defer app.operations.Done()
		result <- app.sendAcceptedCallMessage(app.ctx, conversationID, receipt)
	}()
	select {
	case err := <-result:
		return err
	case <-requestContext.Done():
		return requestContext.Err()
	case <-app.ctx.Done():
		return work.ErrClosed
	}
}

func (app *WorkerApp) sendAcceptedCallMessage(ctx context.Context, conversationID string, receipt work.AdmissionReceipt) error {
	message := receipt.Message
	err := app.engine.ConversationTransaction(ctx, conversationID, func(ctx context.Context) error {
		return app.store.Mutate(ctx, func(state *contracts.State) error {
			stored, err := store.FindMessage(state, message.ID)
			if err != nil || stored.ClientMessageID != message.ClientMessageID {
				return work.ErrStaleOwner
			}
			stored.VoiceCallID = receipt.CallID
			stored.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusRunning))
			stored.Submission = contracts.Some(contracts.SubmissionStatusSubmitting)
			return nil
		})
	})
	if err != nil {
		return err
	}
	var reply *contracts.ChatMessage
	if message.ReplyTo.Value != "" {
		reply, _ = app.store.Message(message.ReplyTo.Value)
	}
	reference, referenceError := app.engine.MemoryReference(ctx, message, message.WorkID, message.Text)
	var delivery voice.InputResult
	if referenceError == nil {
		delivery, err = app.calls.Message(ctx, voice.MessageOptions{CallID: receipt.CallID, Message: message, Reply: reply, IsCurrent: func() bool { return app.callInputCurrent(conversationID, receipt.CallID, message.ID) }, MemoryReference: func() string { return reference }})
	} else {
		err = referenceError
	}
	submission := contracts.SubmissionStatusConfirmed
	if err != nil {
		submission = contracts.SubmissionStatusUnknown
		var known *voice.VoiceInputError
		if referenceError != nil || errors.As(err, &known) && !known.UnknownOutcome {
			submission = contracts.SubmissionStatusNotSubmitted
		}
	} else {
		submission = delivery.Submission
	}
	saveError := app.store.Mutate(app.ctx, func(state *contracts.State) error {
		if state.ConversationID != conversationID {
			return work.ErrStaleOwner
		}
		stored, lookupError := store.FindMessage(state, message.ID)
		if lookupError != nil || stored.VoiceCallID != receipt.CallID {
			return work.ErrStaleOwner
		}
		stored.Submission = contracts.Some(submission)
		stored.UnknownOutcome = submission == contracts.SubmissionStatusUnknown
		if submission == contracts.SubmissionStatusConfirmed {
			stored.ExecutorConfirmedAt = contracts.Some(app.store.Timestamp())
			stored.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusReview))
		} else {
			stored.Status = contracts.Some(contracts.MessageStatus(contracts.TaskStatusPaused))
			stored.PauseReason = contracts.Some("voice-input-unconfirmed")
		}
		return nil
	})
	app.change()
	if saveError != nil {
		return &runtime.OperationError{Cause: saveError, UnknownOutcome: true}
	}
	if err != nil {
		return &runtime.OperationError{Cause: runtime.ErrRequestFailed, UnknownOutcome: submission == contracts.SubmissionStatusUnknown}
	}
	return nil
}

func (app *WorkerApp) receiveVisible(writer http.ResponseWriter, request *http.Request) error {
	body, err := httpapi.ReadObject(writer, request, 0)
	if err != nil {
		return err
	}
	ids, err := routeStrings(body["ids"], visibleReceiptLimit)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if id == "" || contracts.UTF16Length(id) > history.MessageIDLimit {
			return httpapi.Failure(400, "invalid_visible_ids", "Invalid visible message IDs.")
		}
	}
	var snapshots map[string][]string
	if raw, present := body["attachmentSnapshots"]; present {
		object, err := contracts.DecodeObject(raw, len(raw))
		if err != nil || len(object) > len(ids) {
			return httpapi.Failure(400, "invalid_attachment_receipts", "Invalid visible attachment snapshots.")
		}
		snapshots = make(map[string][]string)
		for id, encoded := range object {
			if !slices.Contains(ids, id) {
				return httpapi.Failure(400, "invalid_attachment_receipts", "Invalid visible attachment snapshots.")
			}
			files, err := routeStrings(encoded, work.MaxDeliveredFiles)
			if err != nil {
				return err
			}
			for _, file := range files {
				if !receiptFileID.MatchString(file) {
					return httpapi.Failure(400, "invalid_attachment_receipts", "Invalid visible attachment snapshots.")
				}
			}
			snapshots[id] = files
		}
	}
	conversationID, err := routeConversation(body, app.store.ConversationID())
	if err != nil {
		return err
	}
	if err := app.engine.ConversationTransaction(request.Context(), conversationID, func(ctx context.Context) error { return app.store.MarkVisible(ctx, ids, snapshots) }); err != nil {
		return conversationRouteError(err)
	}
	app.change()
	return httpapi.JSON(writer, struct {
		OK bool `json:"ok"`
	}{true})
}
