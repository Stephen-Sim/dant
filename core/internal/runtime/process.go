package runtime

import (
	"context"
	"io"
	"os/exec"
	"sync"
	"syscall"
)

type ProcessOptions struct {
	Command     string
	Args        []string
	Directory   string
	Environment []string
}
type Executor struct {
	RPC     *RPC
	Stopped <-chan struct{}
	Stop    func() error
}
type ProcessFactory func(context.Context, ProcessOptions) (*Executor, error)

// SpawnExecutor is invoked only after LocalWorker verifies its Linux VM role.
// No shell or host-side executor is involved, and stderr is never published.
func SpawnExecutor(ctx context.Context, options ProcessOptions) (*Executor, error) {
	command := exec.CommandContext(ctx, options.Command, options.Args...)
	command.Dir = options.Directory
	command.Env = options.Environment
	input, err := command.StdinPipe()
	if err != nil {
		return nil, ErrDisconnected
	}
	output, err := command.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, ErrDisconnected
	}
	command.Stderr = io.Discard
	if err = command.Start(); err != nil {
		input.Close()
		output.Close()
		return nil, ErrDisconnected
	}
	stopped := make(chan struct{})
	var stopOnce sync.Once
	stop := func() error {
		var result error
		stopOnce.Do(func() {
			result = command.Process.Signal(syscall.SIGTERM)
		})
		return result
	}
	rpc, err := NewRPC(ctx, input, output, func() {
		_ = stop()
	})
	if err != nil {
		_ = stop()
		_ = command.Wait()
		return nil, err
	}
	go func() {
		_ = command.Wait()
		close(stopped)
		rpc.fail(ErrDisconnected)
	}()
	return &Executor{RPC: rpc, Stopped: stopped, Stop: stop}, nil
}
