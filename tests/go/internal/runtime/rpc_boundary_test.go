package runtime

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestRPCRejectsMalformedOutboundValuesBeforeQueueingAnyFrame(t *testing.T) {
	fixture := newRPCFixture(t)
	client := fixture.client
	if _, err := NewRPC(t.Context(), nil, nil, nil); !errors.Is(err, ErrDisconnected) {
		t.Fatal("missing process pipes accepted", err)
	}
	for _, method := range []string{"", "bad\nmethod", strings.Repeat("x", 257)} {
		if _, err := client.Request(t.Context(), method, nil); !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("invalid request method was sent", err)
		}
		if err := client.Notify(t.Context(), method, nil); !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("invalid notification method was sent", err)
		}
	}
	invalid := contracts.RawObject{"invalid": json.RawMessage(`{`)}
	if _, err := client.Request(t.Context(), "fixture/read", invalid); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("invalid raw request body was sent", err)
	}
	if err := client.Notify(t.Context(), "fixture/notice", invalid); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("invalid raw notification body was sent", err)
	}
	for _, test := range []struct {
		id   RPCID
		body json.RawMessage
	}{{RPCID{}, json.RawMessage(`{}`)}, {NumericRPCID(1), json.RawMessage(`{`)}} {
		if err := client.Reply(t.Context(), test.id, test.body); !errors.Is(err, ErrInvalidProtocol) {
			t.Fatal("invalid RPC reply was sent", err)
		}
	}
	if err := client.ReplyError(t.Context(), RPCID{}, -1, "fixture"); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("unowned error reply was sent", err)
	}
	if err := client.ReplyError(t.Context(), NumericRPCID(1), -1, strings.Repeat("x", 1025)); !errors.Is(err, ErrInvalidProtocol) {
		t.Fatal("oversized error reply was sent", err)
	}
	select {
	case <-fixture.requests:
		t.Fatal("invalid outbound value reached process input")
	default:
	}
}

func TestRPCRepliesAndNotificationsPreserveTheirExplicitWireKinds(t *testing.T) {
	fixture := newRPCFixture(t)
	if err := fixture.client.Reply(t.Context(), NumericRPCID(7), json.RawMessage(`{"accepted":true}`)); err != nil {
		t.Fatal(err)
	}
	result := <-fixture.requests
	if string(result["id"]) != "7" || string(result["result"]) != `{"accepted":true}` || result["error"] != nil || result["method"] != nil {
		t.Fatal("RPC result reply changed wire identity")
	}
	if err := fixture.client.ReplyError(t.Context(), NumericRPCID(8), -32000, "isolated rejection"); err != nil {
		t.Fatal(err)
	}
	result = <-fixture.requests
	if string(result["id"]) != "8" || result["error"] == nil || result["result"] != nil {
		t.Fatal("RPC error reply was converted into a successful result")
	}
	if err := fixture.client.Notify(t.Context(), "fixture/notice", nil); err != nil {
		t.Fatal(err)
	}
	result = <-fixture.requests
	if string(result["method"]) != `"fixture/notice"` || result["id"] != nil || string(result["params"]) != `{}` {
		t.Fatal("notification acquired a request identity")
	}
	_, unsubscribe, err := fixture.client.SubscribeEvents()
	if err != nil {
		t.Fatal(err)
	}
	unsubscribe()
	unsubscribe()
	fixture.client.Close()
	if _, _, err := fixture.client.SubscribeEvents(); !errors.Is(err, ErrDisconnected) {
		t.Fatal("closed process accepted event subscription", err)
	}
	if err := fixture.client.Reply(t.Context(), NumericRPCID(9), json.RawMessage(`{}`)); !errors.Is(err, ErrDisconnected) {
		t.Fatal("closed process accepted result reply", err)
	}
}
