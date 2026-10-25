package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

// This is a complete, valid legacy history response without allocating its
// entire item payload in the fixture. The production scanner retains its bound.
type legacyHistoryFrame struct {
	ready     chan struct{}
	closed    chan struct{}
	once      sync.Once
	prefix    []byte
	suffix    []byte
	position  int
	remaining int
}

func (frame *legacyHistoryFrame) Read(output []byte) (int, error) {
	select {
	case <-frame.ready:
	case <-frame.closed:
		return 0, io.ErrClosedPipe
	}
	count := min(len(output), frame.remaining)
	for index := range count {
		at := frame.position + index
		switch {
		case at < len(frame.prefix):
			output[index] = frame.prefix[at]
		case at >= MaxRPCFrameBytes+1-len(frame.suffix):
			output[index] = frame.suffix[at-(MaxRPCFrameBytes+1-len(frame.suffix))]
		default:
			output[index] = 'x'
		}
	}
	frame.position += count
	frame.remaining -= count
	if frame.remaining == 0 {
		return count, io.EOF
	}
	return count, nil
}

func (frame *legacyHistoryFrame) Close() error {
	frame.once.Do(func() { close(frame.closed) })
	return nil
}

func TestLegacyFullThreadHistoryCannotWeakenTheRPCFrameBoundaryOrStartATurn(t *testing.T) {
	frame := &legacyHistoryFrame{ready: make(chan struct{}), closed: make(chan struct{}), remaining: MaxRPCFrameBytes + 1}
	inputReader, input := io.Pipe()
	client, err := NewRPC(t.Context(), input, frame, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		client.Close()
		inputReader.Close()
		<-client.Done()
	})
	done := make(chan error, 1)
	go func() {
		_, err := client.Request(context.Background(), "thread/read", contracts.RawObject{
			"threadId": json.RawMessage(`"thread-fixture"`), "includeTurns": json.RawMessage(`true`),
		})
		done <- err
	}()
	line, err := bufio.NewReader(inputReader).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	request, err := contracts.DecodeObject(line, MaxRPCFrameBytes)
	if err != nil || string(request["method"]) != `"thread/read"` {
		t.Fatal("fixture did not observe the one legacy history request", err)
	}
	frame.prefix = append([]byte(`{"id":`), request["id"]...)
	frame.prefix = append(frame.prefix, []byte(`,"result":{"thread":{"id":"thread-fixture","status":{"type":"idle"},"turns":[{"id":"selected-known-turn","status":"interrupted","items":[{"type":"agentMessage","id":"legacy-bulk","text":"`)...)
	frame.suffix = []byte(`"}]}]}}}`)
	if !json.Valid(append(append(append([]byte{}, frame.prefix...), 'x'), frame.suffix...)) {
		t.Fatal("fixture is not a valid thread/read response")
	}
	close(frame.ready)
	var operation *OperationError
	if err := <-done; err == nil || !errors.As(err, &operation) {
		t.Fatal("oversized history became a successful RPC response", err)
	}
	<-client.Done()
	if !client.Closed() || frame.remaining != 0 || client.closureReason() != DisconnectFrameTooLarge {
		t.Fatal("legacy bulk history lost its fixed frame-too-large boundary")
	}
	if _, err := client.Request(t.Context(), "turn/start", contracts.RawObject{}); !errors.Is(err, ErrDisconnected) {
		t.Fatal("retired history transport admitted an execution turn", err)
	}
	if MaxRPCFrameBytes != 64*1024*1024 {
		t.Fatal("history regression changed the protocol limit")
	}
}
