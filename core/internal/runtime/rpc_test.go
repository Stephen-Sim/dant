package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type rpcFixture struct {
	client   *RPC
	requests <-chan contracts.RawObject
	output   *io.PipeWriter
}

func newRPCFixture(t *testing.T) *rpcFixture {
	t.Helper()
	readInput, input := io.Pipe()
	output, writeOutput := io.Pipe()
	client, err := NewRPC(context.Background(), input, output, nil)
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan contracts.RawObject, 32)
	go func() {
		defer close(requests)
		scanner := bufio.NewScanner(readInput)
		scanner.Buffer(make([]byte, 4096), MaxRPCFrameBytes+1)
		for scanner.Scan() {
			object, err := contracts.DecodeObject(scanner.Bytes(), MaxRPCFrameBytes)
			if err == nil {
				requests <- object
			}
		}
	}()
	t.Cleanup(func() {
		client.Close()
		readInput.Close()
		writeOutput.Close()
		<-client.Done()
	})
	return &rpcFixture{client: client, requests: requests, output: writeOutput}
}

func (f *rpcFixture) send(t *testing.T, raw string) {
	t.Helper()
	if _, err := io.WriteString(f.output, raw+"\n"); err != nil {
		t.Fatal(err)
	}
}

func TestRPCIDTypeAndNumericSpellingRemainExact(t *testing.T) {
	for _, test := range []struct {
		raw, key string
	}{{`1`, "n:1"}, {`1.0`, "n:1"}, {`1e0`, "n:1"}, {`"1"`, "s:1"}, {`"provider-request"`, "s:provider-request"}} {
		value, err := ParseRPCID(json.RawMessage(test.raw))
		if err != nil || value.Key() != test.key {
			t.Fatal("RPC identity changed")
		}
		encoded, err := json.Marshal(value)
		if err != nil || string(encoded) != test.raw {
			t.Fatal("reply lost provider ID representation")
		}
	}
	for _, invalid := range []string{`null`, `true`, `[]`, `{}`, `"\ud800"`, `1e999`, `1 {}`} {
		if _, err := ParseRPCID(json.RawMessage(invalid)); err == nil {
			t.Fatal("invalid RPC identity accepted")
		}
	}
}

func TestRPCReplyCorrelatesWhileUnsolicitedRequestsRemainEvents(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newRPCFixture(t)
		events, unsubscribe, err := f.client.SubscribeEvents()
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribe()
		result := make(chan rpcResult, 1)
		go func() {
			object, err := f.client.Request(context.Background(), "turn/start", contracts.RawObject{"input": json.RawMessage(`[]`)})
			result <- rpcResult{object: object, err: err}
		}()
		request := <-f.requests
		if string(request["id"]) != "1" {
			t.Fatal("request ID was not registered before sending")
		}
		f.send(t, `{"method":"item/tool/requestUserInput","id":"provider-query","params":{"threadId":"thread","turnId":"turn"}}`)
		event := <-events
		if !event.IsRequest() || event.ID.Value.Key() != "s:provider-query" {
			t.Fatal("provider request was consumed as a response")
		}
		f.send(t, `{"id":1.0,"result":{"turn":{"id":"turn"},"future":true}}`)
		response := <-result
		if response.err != nil || string(response.object["future"]) != "true" {
			t.Fatal("numeric ID spelling failed response correlation")
		}
		reply := make(chan error, 1)
		go func() {
			reply <- f.client.Reply(context.Background(), event.ID.Value, json.RawMessage(`{"answers":{}}`))
		}()
		envelope := <-f.requests
		if string(envelope["id"]) != `"provider-query"` || <-reply != nil {
			t.Fatal("reply changed provider request identity")
		}
	})
}

func TestCancelledSentRequestIsUnknownAndItsLateReplyCannotResolveAnotherRequest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newRPCFixture(t)
		ctx, cancel := context.WithCancel(context.Background())
		first := make(chan error, 1)
		go func() {
			_, err := f.client.Request(ctx, "turn/start", nil)
			first <- err
		}()
		<-f.requests
		cancel()
		err := <-first
		var operation *OperationError
		if !errors.As(err, &operation) || !operation.UnknownOutcome {
			t.Fatal("a sent cancelled action became a safe retry")
		}
		second := make(chan rpcResult, 1)
		go func() {
			object, err := f.client.Request(context.Background(), "thread/read", nil)
			second <- rpcResult{object: object, err: err}
		}()
		request := <-f.requests
		if string(request["id"]) != "2" {
			t.Fatal("request identity was reused")
		}
		f.send(t, `{"id":1,"result":{"late":true}}`)
		f.send(t, `{"id":2,"result":{"thread":{"id":"current"}}}`)
		response := <-second
		if response.err != nil || response.object["late"] != nil {
			t.Fatal("late response polluted another request")
		}
	})
}

func TestProviderErrorDoesNotExposeItsRawCauseThroughError(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newRPCFixture(t)
		result := make(chan error, 1)
		go func() {
			_, err := f.client.Request(context.Background(), "thread/read", nil)
			result <- err
		}()
		<-f.requests
		f.send(t, `{"id":1,"error":{"code":-1,"message":"private provider content","data":{"future":true}}}`)
		err := <-result
		var operation *OperationError
		if !errors.As(err, &operation) || operation.UnknownOutcome || strings.Contains(err.Error(), "private") || operation.Message != "private provider content" {
			t.Fatal("provider rejection leaked or lost uncertainty metadata")
		}
	})
}

func TestDisconnectRejectsEveryPendingActionWithoutRetry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newRPCFixture(t)
		results := make(chan error, 2)
		for index := 0; index < 2; index++ {
			go func() {
				_, err := f.client.Request(context.Background(), "turn/start", nil)
				results <- err
			}()
		}
		<-f.requests
		<-f.requests
		f.output.Close()
		for index := 0; index < 2; index++ {
			err := <-results
			var operation *OperationError
			if !errors.As(err, &operation) || !operation.UnknownOutcome || !errors.Is(err, ErrDisconnected) {
				t.Fatal("disconnect made a sent action safe to resend")
			}
		}
		if !f.client.Closed() {
			t.Fatal("disconnect did not close the RPC session")
		}
	})
}

func TestMalformedProviderErrorRemainsAnUnknownSentOutcome(t *testing.T) {
	for _, invalid := range []string{`{"message":"private"}`, `{"code":null,"message":"private"}`, `{"code":-1,"message":null}`, `{"code":1.5,"message":"private"}`} {
		t.Run(invalid, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fixture := newRPCFixture(t)
				result := make(chan error, 1)
				go func() { _, err := fixture.client.Request(context.Background(), "turn/start", nil); result <- err }()
				<-fixture.requests
				fixture.send(t, `{"id":1,"error":`+invalid+`}`)
				err := <-result
				var operation *OperationError
				if !errors.As(err, &operation) || !operation.UnknownOutcome || !errors.Is(err, ErrInvalidProtocol) || strings.Contains(err.Error(), "private") {
					t.Fatal("malformed rejection became safe to replay or exposed raw content", err)
				}
			})
		})
	}
}
