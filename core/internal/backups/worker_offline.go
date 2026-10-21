package backups

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	processStatusLimit      = 16 * 1024
	processArgumentsLimit   = 32 * 1024
	processEnvironmentLimit = 128 * 1024
	processIdentityLimit    = 4096
	processCountLimit       = 32768
)

type offlineInspection struct {
	home, data, proc string
	uid              int
	selfPID          int
	running          func(context.Context) (bool, error)
}

// AssertWorkerOffline independently confirms the stopped service, its empty
// cgroup and any surviving owned executor processes before preparing data.
// Captured startup paths identify this Worker; unrelated user sessions survive.
func AssertWorkerOffline(ctx context.Context, home, dataDir string) error {
	if contracts.RuntimeOperatingSystem(runtime.GOOS) != contracts.RuntimeOperatingSystemLinux {
		return ErrBusy
	}
	return inspectWorkerOffline(ctx, offlineInspection{
		home: home, data: dataDir, proc: "/proc", uid: os.Geteuid(), selfPID: os.Getpid(),
		running: newSystemdBackupService().Running,
	})
}

func inspectWorkerOffline(ctx context.Context, options offlineInspection) error {
	if !filepath.IsAbs(options.home) || !filepath.IsAbs(options.data) || options.uid <= 0 || options.running == nil {
		return ErrBusy
	}
	checkService := func() error {
		running, err := options.running(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil || running {
			return ErrBusy
		}
		return ctx.Err()
	}
	if err := checkService(); err != nil {
		return err
	}
	root, err := os.OpenRoot(options.proc)
	if err != nil {
		return ErrBusy
	}
	defer root.Close()
	directory, err := root.Open(".")
	if err != nil {
		return ErrBusy
	}
	defer directory.Close()
	processes, err := directory.ReadDir(processCountLimit + 1)
	if err != nil && !errors.Is(err, io.EOF) || len(processes) > processCountLimit {
		return ErrBusy
	}
	for _, process := range processes {
		if err := ctx.Err(); err != nil {
			return err
		}
		pid, err := strconv.ParseUint(process.Name(), 10, 32)
		if err != nil || pid == 0 || strconv.FormatUint(pid, 10) != process.Name() {
			continue
		}
		if options.selfPID > 0 && pid == uint64(options.selfPID) {
			continue // This exact maintenance process is not a surviving executor.
		}
		owned, err := ownedExecutorProcess(ctx, root, process.Name(), options)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, os.ErrNotExist) {
			continue // The inspected process exited; it cannot keep executing work.
		}
		if err != nil || owned {
			return ErrBusy
		}
	}
	return checkService()
}

func readProcessFile(ctx context.Context, root *os.Root, name string, maximum int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(raw)) > maximum {
		clear(raw)
		return nil, ErrBusy
	}
	if err := ctx.Err(); err != nil {
		clear(raw)
		return nil, err
	}
	return raw, nil
}

func processUID(raw []byte) (int, error) {
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		if !bytes.HasPrefix(line, []byte("Uid:")) {
			continue
		}
		fields := bytes.Fields(line[len("Uid:"):])
		if len(fields) != 4 {
			return 0, ErrBusy
		}
		uid, err := strconv.ParseUint(string(fields[0]), 10, 32)
		if err != nil {
			return 0, ErrBusy
		}
		return int(uid), nil
	}
	return 0, ErrBusy
}

func processStart(raw []byte, pid string) (string, error) {
	if !bytes.HasPrefix(raw, []byte(pid+" (")) {
		return "", ErrBusy
	}
	end := bytes.LastIndex(raw, []byte(") "))
	if end < 0 {
		return "", ErrBusy
	}
	fields := bytes.Fields(raw[end+2:])
	if len(fields) < 20 {
		return "", ErrBusy
	}
	start := string(fields[19])
	if _, err := strconv.ParseUint(start, 10, 64); err != nil {
		return "", ErrBusy
	}
	return start, nil
}

func ownedExecutorProcess(ctx context.Context, root *os.Root, pid string, options offlineInspection) (bool, error) {
	status, err := readProcessFile(ctx, root, pid+"/status", processStatusLimit)
	if err != nil {
		return false, err
	}
	uid, err := processUID(status)
	if err != nil || uid != options.uid {
		return false, err
	}
	arguments, err := readProcessFile(ctx, root, pid+"/cmdline", processArgumentsLimit)
	if err != nil {
		return false, err
	}
	defer clear(arguments)
	command, _, _ := bytes.Cut(arguments, []byte{0})
	switch filepath.Base(string(command)) {
	case "node", "nodejs", "codex", "dant-core":
	default:
		return false, nil
	}
	before, err := readProcessFile(ctx, root, pid+"/stat", processIdentityLimit)
	if err != nil {
		return false, err
	}
	start, err := processStart(before, pid)
	if err != nil {
		return false, err
	}
	environment, err := readProcessFile(ctx, root, pid+"/environ", processEnvironmentLimit)
	if err != nil {
		return false, err
	}
	defer clear(environment)
	expectedData := []byte("DANT_DATA=" + filepath.Clean(options.data))
	expectedHome := []byte("CODEX_HOME=" + filepath.Join(options.home, ".dant-codex"))
	owned := false
	for _, field := range bytes.Split(environment, []byte{0}) {
		if bytes.Equal(field, expectedData) || bytes.Equal(field, expectedHome) {
			owned = true
			break
		}
	}
	after, err := readProcessFile(ctx, root, pid+"/stat", processIdentityLimit)
	if err != nil {
		return false, err
	}
	current, err := processStart(after, pid)
	if err != nil || current != start {
		return false, ErrBusy
	}
	return owned, nil
}
