package backups

import (
	"context"
	"os"
	"path"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/platform"
)

const systemdCheckTimeout = 5 * time.Second
const systemdStartTimeout = 30 * time.Second
const systemdOutputLimit = 4096

type systemdBackupService struct {
	operatingSystem contracts.RuntimeOperatingSystem
	run             func(context.Context, string, []string) ([]byte, error)
	readFile        func(string) ([]byte, error)
}

func newSystemdBackupService() systemdBackupService {
	return systemdBackupService{
		operatingSystem: contracts.RuntimeOperatingSystem(runtime.GOOS),
		run: func(ctx context.Context, executable string, arguments []string) ([]byte, error) {
			return platform.RunLimited(ctx, executable, arguments, nil, systemdOutputLimit)
		},
		readFile: os.ReadFile,
	}
}

func (service systemdBackupService) Running(ctx context.Context) (bool, error) {
	if service.operatingSystem != contracts.RuntimeOperatingSystemLinux {
		return false, ErrRestoreFailed
	}
	check, stop := context.WithTimeout(ctx, systemdCheckTimeout)
	defer stop()
	raw, err := service.run(check, "systemctl", []string{"--user", "show", "dant-worker.service", "--property=ActiveState", "--property=MainPID", "--property=ControlGroup", "--no-pager"})
	if err != nil || len(raw) > systemdOutputLimit {
		return false, ErrBusy
	}
	fields := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		pair := strings.SplitN(line, "=", 2)
		if len(pair) != 2 {
			return false, ErrBusy
		}
		switch pair[0] {
		case "ActiveState", "MainPID", "ControlGroup":
		default:
			return false, ErrBusy
		}
		if _, exists := fields[pair[0]]; exists {
			return false, ErrBusy
		}
		fields[pair[0]] = pair[1]
	}

	if len(fields) != 3 {
		return false, ErrBusy
	}
	pid, err := strconv.ParseUint(fields["MainPID"], 10, 32)
	if err != nil || strconv.FormatUint(pid, 10) != fields["MainPID"] {
		return false, ErrBusy
	}

	if fields["ActiveState"] == "active" && pid > 0 {
		return true, nil
	}

	if (fields["ActiveState"] != "inactive" && fields["ActiveState"] != "failed") || pid != 0 {
		return false, ErrBusy
	}
	group := fields["ControlGroup"]
	if group != "" {
		if !strings.HasPrefix(group, "/") || path.Clean(group) != group || !strings.HasSuffix(group, "/dant-worker.service") {
			return false, ErrBusy
		}
		name := path.Join("/sys/fs/cgroup", group, "cgroup.procs")
		raw, err := service.readFile(name)
		if err != nil && !os.IsNotExist(err) {
			return false, ErrBusy
		}
		if len(raw) > systemdOutputLimit || len(strings.TrimSpace(string(raw))) != 0 {
			return false, ErrBusy
		}
	}

	return false, nil
}

func (service systemdBackupService) Start(ctx context.Context) error {
	if service.operatingSystem != contracts.RuntimeOperatingSystemLinux {
		return ErrRestoreFailed
	}
	start, stop := context.WithTimeout(ctx, systemdStartTimeout)
	defer stop()
	if _, err := service.run(start, "systemctl", []string{"--user", "start", "dant-worker.service"}); err != nil {
		return ErrRestoreFailed
	}

	return nil
}
