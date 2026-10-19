package stdio

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/transport"
)

type readerFixture struct {
	search   func(context.Context, memory.PreparedQuery, memory.SearchOptions) ([]memory.SearchResult, error)
	retrieve func(context.Context, memory.PreparedQuery, memory.Scope, memory.RetrieveOptions) ([]memory.Reference, error)
}

func (reader readerFixture) Search(ctx context.Context, query memory.PreparedQuery, options memory.SearchOptions) ([]memory.SearchResult, error) {
	return reader.search(ctx, query, options)
}
func (reader readerFixture) Retrieve(ctx context.Context, query memory.PreparedQuery, scope memory.Scope, options memory.RetrieveOptions) ([]memory.Reference, error) {
	return reader.retrieve(ctx, query, scope, options)
}

func TestAdapterPreservesOmissionAndSuppliesOnlyTheDocumentedDefaults(t *testing.T) {
	checks := 0
	guard := func() error { checks++; return nil }
	reader := readerFixture{
		search: func(_ context.Context, query memory.PreparedQuery, options memory.SearchOptions) ([]memory.SearchResult, error) {
			if len(query.Terms) != 1 || query.Terms[0] != "typescript" || options.ConversationID != nil || options.Limit != memory.DefaultSearchLimit {
				t.Fatal("search fields were silently changed")
			}
			return nil, nil
		},
		retrieve: func(_ context.Context, query memory.PreparedQuery, scope memory.Scope, options memory.RetrieveOptions) ([]memory.Reference, error) {
			if len(query.Terms) != 0 || scope.ConversationID != "conversation" || scope.WorkID != nil || options.Limit != memory.DefaultRetrieveLimit {
				t.Fatal("retrieval fields were silently changed")
			}
			return nil, nil
		},
	}
	handler := NewHandler(guard, reader, 7)
	for _, request := range []transport.Request{
		{Method: transport.MethodSearch, Params: json.RawMessage(`{"query":{"terms":["typescript"]}}`)},
		{Method: transport.MethodRetrieve, Params: json.RawMessage(`{"query":{"terms":[]},"scope":{"conversationId":"conversation"}}`)},
	} {
		result, err := handler(context.Background(), request)
		if err != nil || string(result) != "[]" {
			t.Fatal("empty results did not retain their array shape")
		}
	}
	if checks != 4 {
		t.Fatal("snapshot guard did not run before and after each read")
	}
}

func TestInvalidParamsNeverReachTheDomainReader(t *testing.T) {
	calls := 0
	reader := readerFixture{
		search: func(context.Context, memory.PreparedQuery, memory.SearchOptions) ([]memory.SearchResult, error) {
			calls++
			return nil, nil
		},
		retrieve: func(context.Context, memory.PreparedQuery, memory.Scope, memory.RetrieveOptions) ([]memory.Reference, error) {
			calls++
			return nil, nil
		},
	}
	handler := NewHandler(func() error { return nil }, reader, 7)
	for _, request := range []transport.Request{
		{Method: transport.MethodSearch, Params: json.RawMessage(`{"query":{"terms":[null]}}`)},
		{Method: transport.MethodSearch, Params: json.RawMessage(`{"query":{"terms":[7]}}`)},
		{Method: transport.MethodSearch, Params: json.RawMessage(`{"query":{"terms":null}}`)},
		{Method: transport.MethodSearch, Params: json.RawMessage(`{"query":{"terms":[]},"conversationId":null}`)},
		{Method: transport.MethodSearch, Params: json.RawMessage(`{"query":{"terms":[]},"limit":0}`)},
		{Method: transport.MethodRetrieve, Params: json.RawMessage(`{"query":{"terms":[]},"scope":{"conversationId":"conversation","workId":null}}`)},
		{Method: transport.MethodRetrieve, Params: json.RawMessage(`{"query":{"terms":[]},"scope":{}}`)},
	} {
		result, err := handler(context.Background(), request)
		if err == nil || err.Error() != string(transport.InvalidParams) || result != nil {
			t.Fatal("invalid parameters were accepted")
		}
	}
	if calls != 0 {
		t.Fatal("invalid transport input reached the domain")
	}
}

func TestChangingSnapshotDiscardsCompletedReadWithoutGivingTheReaderTransportOwnership(t *testing.T) {
	checks, calls := 0, 0
	reader := readerFixture{search: func(context.Context, memory.PreparedQuery, memory.SearchOptions) ([]memory.SearchResult, error) {
		calls++
		return []memory.SearchResult{{ID: "identity.md", Kind: "note"}}, nil
	}}
	guard := func() error {
		checks++
		if checks > 1 {
			return transport.NewError(transport.InvalidSnapshot)
		}
		return nil
	}
	result, err := NewHandler(guard, reader, 7)(context.Background(), transport.Request{Method: transport.MethodSearch, Params: json.RawMessage(`{"query":{"terms":[]}}`)})
	if err == nil || err.Error() != string(transport.InvalidSnapshot) || result != nil || calls != 1 {
		t.Fatal("a result from a changed snapshot escaped its guard")
	}
	checks = 1
	_, err = NewHandler(guard, reader, 7)(context.Background(), transport.Request{Method: transport.MethodSearch, Params: json.RawMessage(`{"query":{"terms":[]}}`)})
	if err == nil || calls != 1 {
		t.Fatal("a failed initial guard did not stop the read")
	}
}

func TestDomainErrorsRemainFixedAndCancellationIsNotDisguised(t *testing.T) {
	for _, test := range []struct {
		cause error
		code  transport.Code
	}{
		{memory.ErrInvalidQuery, transport.InvalidParams},
		{memory.ErrInvalidScope, transport.InvalidParams},
		{memory.ErrInvalidLimit, transport.InvalidParams},
		{memory.ErrStaleSnapshot, transport.StaleSnapshot},
		{memory.ErrInvalidSnapshot, transport.InvalidSnapshot},
		{memory.ErrUnavailable, transport.Unavailable},
		{errors.New("private SQL, path or credentials"), transport.Unavailable},
	} {
		if err := Error(test.cause); err == nil || err.Error() != string(test.code) {
			t.Fatal("domain error was exposed or incorrectly translated")
		}
	}
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
		if !errors.Is(Error(cause), cause) {
			t.Fatal("cancellation lost its identity")
		}
	}
	if Error(nil) != nil {
		t.Fatal("a successful operation acquired an error")
	}
}
