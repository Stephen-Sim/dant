package runtime

import (
	"bufio"
	"context"
	"errors"
	"io"
	"sync"
	"testing"
)

type oversizedEOFReader struct {
	start     <-chan struct{}
	closed    chan struct{}
	once      sync.Once
	remaining int
}

func (reader *oversizedEOFReader) Read(data []byte) (int, error) {
	select {
	case <-reader.start:
	case <-reader.closed:
		return 0, io.ErrClosedPipe
	}
	count := min(len(data), reader.remaining)
	const prefix = `{"method":"fixture/oversized","params":{"text":"`
	const suffix = `"}}`
	position := MaxRPCFrameBytes + 1 - reader.remaining
	for index := range count {
		offset := position + index
		switch {
		case offset < len(prefix):
			data[index] = prefix[offset]
		case offset >= MaxRPCFrameBytes+1-len(suffix):
			data[index] = suffix[offset-(MaxRPCFrameBytes+1-len(suffix))]
		default:
			data[index] = 'x'
		}
	}
	reader.remaining -= count
	if reader.remaining == 0 {
		return count, io.EOF
	}
	return count, nil
}

func (reader *oversizedEOFReader) Close() error {
	reader.once.Do(func() {
		close(reader.closed)
	})
	return nil
}

func TestOversizedFinalRPCFrameRetiresSentActionsWithoutAllowingReplay(t *testing.T) {
	start := make(chan struct{})
	output := &oversizedEOFReader{start: start, closed: make(chan struct{}), remaining: MaxRPCFrameBytes + 1}
	inputReader, input := io.Pipe()
	client, err := NewRPC(t.Context(), input, output, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		client.Close()
		inputReader.Close()
		<-client.Done()
	})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := client.Request(ctx, "turn/start", nil)
		done <- err
	}()
	if _, err := bufio.NewReader(inputReader).ReadBytes('\n'); err != nil {
		t.Fatal(err)
	}
	close(start)

	var operation *OperationError
	if err := <-done; !errors.Is(err, ErrInvalidProtocol) || !errors.As(err, &operation) || !operation.UnconfirmedOutcome() {
		t.Fatal("oversized provider frame became a successful or replayable action", err)
	}
	<-client.Done()
	if !client.Closed() || output.remaining != 0 {
		t.Fatal("oversized final frame was not bounded and retired")
	}
	if client.closureReason() != DisconnectFrameTooLarge {
		t.Fatal("oversized final frame lost its diagnostic classification")
	}
}
