// Package stdio adapts prepared memory queries to the bounded shadow transport.
// The domain reader does not depend on transport or snapshot files.
package stdio

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/transport"
)

const Role = "memory-shadow"

// Guard rechecks the caller-owned immutable snapshot before and after reads.
type Guard func() error

// Reader contains only the read operations exposed by the shadow protocol.
type Reader interface {
	Search(context.Context, memory.PreparedQuery, memory.SearchOptions) ([]memory.SearchResult, error)
	Retrieve(context.Context, memory.PreparedQuery, memory.Scope, memory.RetrieveOptions) ([]memory.Reference, error)
}

func queryParams(raw json.RawMessage) (memory.PreparedQuery, error) {
	var query memory.PreparedQuery
	object, err := transport.StrictObject(raw, "terms")
	if err != nil || len(object) != 1 || strings.TrimSpace(string(object["terms"])) == "null" {
		return query, transport.NewError(transport.InvalidParams)
	}
	var terms []json.RawMessage
	if json.Unmarshal(object["terms"], &terms) != nil {
		return query, transport.NewError(transport.InvalidParams)
	}
	query.Terms = make([]string, 0, len(terms))
	for _, raw := range terms {
		var term string
		if strings.TrimSpace(string(raw)) == "null" || json.Unmarshal(raw, &term) != nil {
			return memory.PreparedQuery{}, transport.NewError(transport.InvalidParams)
		}
		query.Terms = append(query.Terms, term)
	}
	return query, nil
}

func optionalString(object map[string]json.RawMessage, name string) (*string, error) {
	raw, exists := object[name]
	if !exists {
		return nil, nil
	}
	var value string
	if strings.TrimSpace(string(raw)) == "null" || json.Unmarshal(raw, &value) != nil {
		return nil, transport.NewError(transport.InvalidParams)
	}
	return &value, nil
}

func limitParam(object map[string]json.RawMessage, fallback int) (int, error) {
	raw, exists := object["limit"]
	if !exists {
		return fallback, nil
	}
	var value int
	if json.Unmarshal(raw, &value) != nil || value <= 0 {
		return 0, transport.NewError(transport.InvalidParams)
	}
	return value, nil
}

// Error translates domain errors into fixed codes without exposing their cause.
func Error(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	switch {
	case errors.Is(err, memory.ErrInvalidQuery), errors.Is(err, memory.ErrInvalidScope), errors.Is(err, memory.ErrInvalidLimit):
		return transport.NewError(transport.InvalidParams)
	case errors.Is(err, memory.ErrStaleSnapshot):
		return transport.NewError(transport.StaleSnapshot)
	case errors.Is(err, memory.ErrInvalidSnapshot):
		return transport.NewError(transport.InvalidSnapshot)
	default:
		return transport.NewError(transport.Unavailable)
	}
}

// NewHandler exposes prepared read operations; it cannot execute tasks or write
// memory. The caller owns snapshot immutability, revision and reader lifecycle.
func NewHandler(guard Guard, reader Reader, revision int64) transport.Handler {
	return func(ctx context.Context, request transport.Request) (json.RawMessage, error) {
		if guard == nil || reader == nil {
			return nil, transport.NewError(transport.Unavailable)
		}
		if err := guard(); err != nil {
			return nil, err
		}
		switch request.Method {
		case transport.MethodPing:
			return json.Marshal(struct {
				ProtocolVersion int    `json:"protocolVersion"`
				Role            string `json:"role"`
				Revision        int64  `json:"revision"`
			}{contracts.CoreVersion, Role, revision})
		case transport.MethodSearch:
			params, err := transport.StrictObject(request.Params, "query", "limit", "conversationId")
			if err != nil {
				return nil, err
			}
			query, err := queryParams(params["query"])
			if err != nil {
				return nil, err
			}
			limit, err := limitParam(params, memory.DefaultSearchLimit)
			if err != nil {
				return nil, err
			}
			conversation, err := optionalString(params, "conversationId")
			if err != nil {
				return nil, err
			}
			values, err := reader.Search(ctx, query, memory.SearchOptions{Limit: limit, ConversationID: conversation})
			if err != nil {
				return nil, Error(err)
			}
			if err := guard(); err != nil {
				return nil, err
			}
			if values == nil {
				values = []memory.SearchResult{}
			}
			return json.Marshal(values)
		case transport.MethodRetrieve:
			params, err := transport.StrictObject(request.Params, "query", "scope", "limit")
			if err != nil {
				return nil, err
			}
			query, err := queryParams(params["query"])
			if err != nil {
				return nil, err
			}
			limit, err := limitParam(params, memory.DefaultRetrieveLimit)
			if err != nil {
				return nil, err
			}
			scope, err := transport.StrictObject(params["scope"], "conversationId", "workId")
			if err != nil {
				return nil, err
			}
			conversation, err := optionalString(scope, "conversationId")
			if err != nil || conversation == nil {
				return nil, transport.NewError(transport.InvalidParams)
			}
			work, err := optionalString(scope, "workId")
			if err != nil {
				return nil, err
			}
			values, err := reader.Retrieve(ctx, query, memory.Scope{ConversationID: *conversation, WorkID: work}, memory.RetrieveOptions{Limit: limit})
			if err != nil {
				return nil, Error(err)
			}
			if err := guard(); err != nil {
				return nil, err
			}
			if values == nil {
				values = []memory.Reference{}
			}
			return json.Marshal(values)
		default:
			return nil, transport.NewError(transport.MethodNotAllowed)
		}
	}
}
