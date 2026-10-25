package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"
)

func TestAbsentConversationSessionCleanupThroughInterfaceHasNoChildToStop(t *testing.T) {
	var session *ConversationSession
	var cleanup interface {
		TerminateConfirmed(context.Context) (bool, error)
	} = session
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if confirmed, err := cleanup.TerminateConfirmed(ctx); !confirmed || err != nil {
		t.Fatal("absent conversation cleanup became an unconfirmed child", err)
	}
}

func TestConversationStartupProtocolRejectionJoinsOnlyItsChildAndPreservesError(t *testing.T) {
	f := sessionFixture(t)
	done := f.opening(t, func() bool { return true })
	request := rpcMethod(t, f.child, "initialize")
	f.child.send(t, `{"id":`+string(request["id"])+`,"error":{"code":-32001,"message":"synthetic startup rejection"}}`)
	var result struct {
		session *ConversationSession
		err     error
	}
	select {
	case result = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("failed child startup did not join")
	case <-t.Context().Done():
		t.Fatal("test scope ended before child cleanup")
	}
	var operation *OperationError
	if result.session != nil || !errors.As(result.err, &operation) || operation.UnknownOutcome {
		t.Fatal("known startup rejection lost its original error classification", result.err)
	}
	select {
	case <-f.stopped:
	default:
		t.Fatal("failed private child was not stopped before returning")
	}
	if _, err := os.Stat(f.process.Directory); !os.IsNotExist(err) {
		t.Fatal("joined private child retained its temporary directory")
	}
	select {
	case <-f.origin.client.Done():
		t.Fatal("private child rejection closed the main executor")
	default:
	}
	response := make(chan error, 1)
	go func() {
		_, err := f.origin.client.Request(t.Context(), "account/read", nil)
		response <- err
	}()
	replyFixture(t, f.origin, rpcMethod(t, f.origin, "account/read"), `{"account":{"type":"apiKey"}}`)
	if err := <-response; err != nil {
		t.Fatal("main executor no longer accepts requests after child startup rejection", err)
	}
	for request := range f.child.requests {
		var method string
		if json.Unmarshal(request["method"], &method) == nil && (method == "thread/start" || method == "turn/start") {
			t.Fatal("startup rejection dispatched model work")
		}
	}
}
