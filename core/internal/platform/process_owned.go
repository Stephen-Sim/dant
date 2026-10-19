package platform

import (
	"context"
	"io"
	"os/exec"
	"sync"
)

// Process owns one shell-free background helper and joins it during shutdown.
type Process struct {
	cancel context.CancelFunc
	done   chan struct{}
	mu     sync.Mutex
	err    error
}

func StartProcess(parent context.Context, executable string, args []string) (*Process, error) {
	if err := parent.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	command := exec.CommandContext(ctx, executable, args...)
	hideWindow(command)
	command.Stdin = nil
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	command.WaitDelay = processExitWait
	if err := command.Start(); err != nil {
		cancel()
		return nil, ErrCommandFailed
	}
	process := &Process{cancel: cancel, done: make(chan struct{})}
	go func() {
		err := command.Wait()
		process.mu.Lock()
		if ctx.Err() != nil {
			process.err = ctx.Err()
		} else if err != nil {
			process.err = ErrCommandFailed
		}
		process.mu.Unlock()
		close(process.done)
	}()
	return process, nil
}

func (process *Process) Done() <-chan struct{} { return process.done }
func (process *Process) Err() error            { process.mu.Lock(); defer process.mu.Unlock(); return process.err }
func (process *Process) Stop()                 { process.cancel(); <-process.done }
