package platform

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"time"
)

var ErrCommandFailed = errors.New("host_command_failed")
var ErrCommandOutputLimit = errors.New("host_command_output_limit")

const CommandOutputLimit = 1024 * 1024
const MaxCommandOutputLimit = 8 * 1024 * 1024
const processExitWait = time.Second

type limitedOutput struct {
	bytes []byte
	limit int
	full  bool
}

func (output *limitedOutput) Write(data []byte) (int, error) {
	if len(data) > output.limit-len(output.bytes) {
		output.full = true
		return 0, ErrCommandOutputLimit
	}
	output.bytes = append(output.bytes, data...)
	return len(data), nil
}

// Run owns a shell-free child until exit. Never exposes stderr or raw process errors.
func Run(ctx context.Context, executable string, args []string, input io.Reader) ([]byte, error) {
	return RunLimited(ctx, executable, args, input, CommandOutputLimit)
}

func RunLimited(ctx context.Context, executable string, args []string, input io.Reader, maximum int) ([]byte, error) {
	if maximum < 1 || maximum > MaxCommandOutputLimit {
		return nil, ErrCommandOutputLimit
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, executable, args...)
	hideWindow(command)
	command.Stdin = input
	command.WaitDelay = processExitWait
	output := &limitedOutput{limit: maximum}
	command.Stdout = output
	command.Stderr = io.Discard
	err := command.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	if output.full {
		return nil, ErrCommandOutputLimit
	}

	if err != nil {
		return nil, ErrCommandFailed
	}

	return output.bytes, nil
}
