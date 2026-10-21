package memory

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"

	"github.com/Stephen-Sim/dant/core/internal/httpapi"
)

type RouteOptions struct {
	Store                   *Store
	ConversationID          func() string
	Redact                  func(context.Context, string) string
	ConversationTransaction func(context.Context, string, func(context.Context) error) error
	Changed                 func(context.Context) error
	SaveNote                func(context.Context, string, string) (json.RawMessage, error)
}

var managementOffset = regexp.MustCompile(`^(?:0|[1-9][0-9]{0,3})$`)
var managementRevision = regexp.MustCompile(`^[0-9]+:[0-9]+$`)

func memoryReadFailure(err error) error {
	status := http.StatusServiceUnavailable
	if errors.Is(err, ErrInvalidMemory) || errors.Is(err, ErrInvalidQuery) {
		status = http.StatusBadRequest
	}
	return httpapi.Failure(status, "memory_read_failed", "Memory could not be read.")
}

func memoryWriteFailure(err error) error {
	if errors.Is(err, ErrConflict) {
		return httpapi.Failure(http.StatusConflict, "memory_conflict", "Refresh memory and check the result before trying again.")
	}
	return httpapi.Failure(http.StatusBadRequest, "memory_write_failed", "Refresh memory and check the result before trying again.")
}

func RegisterRoutes(mux *http.ServeMux, options RouteOptions) {
	redact := func(ctx context.Context) func(string) string {
		return func(text string) string {
			if options.Redact != nil {
				return options.Redact(ctx, text)
			}
			return SanitizeText(text)
		}
	}

	httpapi.Register(mux, "GET /api/memory", func(writer http.ResponseWriter, request *http.Request) error {
		items, err := options.Store.Notes(request.Context())
		if err != nil {
			return memoryReadFailure(err)
		}
		return httpapi.JSON(writer, struct {
			Files []Note `json:"files"`
		}{items})
	})
	httpapi.Register(mux, "PATCH /api/memory/{name}", func(writer http.ResponseWriter, request *http.Request) error {
		object, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		text, err := httpapi.String(object, "text", true)
		if err != nil {
			return err
		}
		if options.SaveNote == nil {
			return memoryWriteFailure(ErrUnavailable)
		}
		result, err := options.SaveNote(request.Context(), request.PathValue("name"), text)
		if err != nil {
			return memoryWriteFailure(err)
		}
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "GET /api/memory/view", func(writer http.ResponseWriter, request *http.Request) error {
		writer.Header().Set("Cache-Control", "no-store")
		conversationID := options.ConversationID()
		result, err := options.Store.View(request.Context(), conversationID, redact(request.Context()))
		if err != nil {
			return memoryReadFailure(err)
		}
		if options.ConversationID() != conversationID {
			return memoryReadFailure(ErrStaleSnapshot)
		}
		return httpapi.JSON(writer, result)
	})
	for _, method := range []string{"HEAD", "POST", "PATCH", "DELETE", "PUT", "OPTIONS", "TRACE", "CONNECT"} {
		mux.HandleFunc(method+" /api/memory/view", func(writer http.ResponseWriter, _ *http.Request) {
			httpapi.WriteError(writer, httpapi.Failure(405, "read_only", "This memory view is read-only."))
		})
	}

	httpapi.Register(mux, "GET /api/memory/manage", func(writer http.ResponseWriter, request *http.Request) error {
		writer.Header().Set("Cache-Control", "no-store")
		query := request.URL.Query()
		for name, values := range query {
			if !slices.Contains([]string{"q", "offset"}, name) || len(values) != 1 {
				return memoryReadFailure(ErrInvalidMemory)
			}
		}
		offsetText := query.Get("offset")
		if offsetText == "" {
			offsetText = "0"
		}
		if !managementOffset.MatchString(offsetText) {
			return memoryReadFailure(ErrInvalidMemory)
		}
		offset, _ := strconv.Atoi(offsetText)
		conversationID := options.ConversationID()
		result, err := options.Store.ManagementPage(request.Context(), conversationID, query.Get("q"), offset, redact(request.Context()))
		if err != nil {
			return memoryReadFailure(err)
		}
		if options.ConversationID() != conversationID {
			return memoryReadFailure(ErrStaleSnapshot)
		}
		return httpapi.JSON(writer, result)
	})

	mutate := func(action string) httpapi.Handler {
		return func(writer http.ResponseWriter, request *http.Request) error {
			object, err := httpapi.ReadObject(writer, request, 0)
			if err != nil {
				return err
			}
			for key := range object {
				if key != "conversationId" && key != "revision" && !(action == "update" && key == "text") {
					return memoryWriteFailure(ErrInvalidMemory)
				}
			}
			conversationID, err := httpapi.String(object, "conversationId", true)
			if err != nil || conversationID != options.ConversationID() {
				return memoryWriteFailure(ErrInvalidMemory)
			}
			revision, err := httpapi.String(object, "revision", true)
			if err != nil || !managementRevision.MatchString(revision) {
				return memoryWriteFailure(ErrInvalidMemory)
			}
			mutation := Mutation{
				Revision: revision,
				Kind:     request.PathValue("kind"),
				ID:       request.PathValue("id"),
				Action:   action,
			}
			if action == "update" {
				text, err := httpapi.String(object, "text", true)
				if err != nil {
					return memoryWriteFailure(ErrInvalidMemory)
				}
				mutation.Text = &text
			}
			if options.ConversationTransaction == nil {
				return memoryWriteFailure(ErrUnavailable)
			}

			var result ManagementResult
			err = options.ConversationTransaction(request.Context(), conversationID, func(ctx context.Context) error {
				var err error
				result, err = options.Store.ManageForConversation(ctx, conversationID, mutation, redact(ctx))
				return err
			})
			if err != nil {
				return memoryWriteFailure(err)
			}
			if options.Changed != nil {
				// The revision is already committed. The owning notification
				// callback reports live-context failures separately from storage.
				_ = options.Changed(request.Context())
			}
			return httpapi.JSON(writer, struct {
				Saved          bool   `json:"saved"`
				ConversationID string `json:"conversationId"`
				Revision       string `json:"revision"`
			}{true, conversationID, result.Revision})
		}
	}
	httpapi.Register(mux, "PATCH /api/memory/manage/{kind}/{id}", mutate("update"))
	httpapi.Register(mux, "DELETE /api/memory/manage/{kind}/{id}", mutate("delete"))
	httpapi.Register(mux, "POST /api/memory/manage/{kind}/{id}/confirm", mutate("confirm"))
}
