package voice

import (
	"bytes"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

type audioOutput struct {
	data       bytes.Buffer
	limit      int
	overflowed bool
	notify     func()
}

func (output *audioOutput) Write(data []byte) (int, error) {
	if output.overflowed {
		return len(data), nil
	}
	if output.data.Len()+len(data) > output.limit {
		output.overflowed = true
		output.data.Reset()
		if output.notify != nil {
			output.notify()
		}
		return len(data), nil
	}
	return output.data.Write(data)
}

type audioProcess struct {
	command  *exec.Cmd
	done     chan TranscriptionProcessResult
	overflow chan struct{}
}

func (process *audioProcess) Done() <-chan TranscriptionProcessResult { return process.done }
func (process *audioProcess) Overflow() <-chan struct{}               { return process.overflow }
func (process *audioProcess) Terminate() error {
	return process.command.Process.Signal(syscall.SIGTERM)
}

func (process *audioProcess) Kill() error { return process.command.Process.Kill() }
func spawnTranscription(options TranscriptionCommand) (TranscriptionProcess, error) {
	command := exec.Command(options.Program, options.Args...)
	command.Dir = options.Directory
	command.Env = options.Environment
	command.Stdin = bytes.NewReader(options.Input)
	command.WaitDelay = time.Second
	process := &audioProcess{command: command, done: make(chan TranscriptionProcessResult, 1), overflow: make(chan struct{})}
	var once sync.Once
	output := &audioOutput{limit: transcriptionOutputBytes, notify: func() { once.Do(func() { close(process.overflow) }) }}
	stderr := &audioOutput{limit: transcriptionErrorBytes}
	command.Stdout = output
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return nil, err
	}
	go func() {
		err := command.Wait()
		code := -1
		if command.ProcessState != nil {
			code = command.ProcessState.ExitCode()
		}
		process.done <- TranscriptionProcessResult{Output: append([]byte{}, output.data.Bytes()...), Stderr: append([]byte{}, stderr.data.Bytes()...), ExitCode: code, Error: err, Overflow: output.overflowed}
		close(process.done)
	}()
	return process, nil
}
