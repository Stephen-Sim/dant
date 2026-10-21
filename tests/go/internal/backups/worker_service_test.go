package backups

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestBackupServiceRequiresCanonicalSystemdStateAndAnEmptyOwnedCgroup(t *testing.T) {
	for _, fixture := range []struct {
		name, output, members  string
		runError, readError    error
		wantRunning, wantError bool
	}{
		{name: "active", output: "ActiveState=active\nMainPID=42\nControlGroup=/user.slice/dant-worker.service\n", wantRunning: true},
		{name: "inactive", output: "ActiveState=inactive\nMainPID=0\nControlGroup=\n"},
		{name: "failed", output: "ActiveState=failed\nMainPID=0\nControlGroup=\n"},
		{name: "empty-cgroup", output: "ActiveState=inactive\nMainPID=0\nControlGroup=/user.slice/dant-worker.service\n", members: " \n"},
		{name: "missing-cgroup", output: "ActiveState=inactive\nMainPID=0\nControlGroup=/user.slice/dant-worker.service\n", readError: os.ErrNotExist},
		{name: "members", output: "ActiveState=inactive\nMainPID=0\nControlGroup=/user.slice/dant-worker.service\n", members: "42\n", wantError: true},
		{name: "cgroup-error", output: "ActiveState=inactive\nMainPID=0\nControlGroup=/user.slice/dant-worker.service\n", readError: errors.New("synthetic private cause"), wantError: true},
		{name: "cgroup-limit", output: "ActiveState=inactive\nMainPID=0\nControlGroup=/user.slice/dant-worker.service\n", members: strings.Repeat(" ", systemdOutputLimit+1), wantError: true},
		{name: "relative-cgroup", output: "ActiveState=inactive\nMainPID=0\nControlGroup=user.slice/dant-worker.service\n", wantError: true},
		{name: "unclean-cgroup", output: "ActiveState=inactive\nMainPID=0\nControlGroup=/user.slice/../dant-worker.service\n", wantError: true},
		{name: "foreign-cgroup", output: "ActiveState=inactive\nMainPID=0\nControlGroup=/user.slice/other.service\n", wantError: true},
		{name: "command-error", runError: context.DeadlineExceeded, wantError: true},
		{name: "output-limit", output: strings.Repeat("x", systemdOutputLimit+1), wantError: true},
		{name: "malformed", output: "not a property", wantError: true},
		{name: "unknown-property", output: "Private=value", wantError: true},
		{name: "duplicate-property", output: "ActiveState=inactive\nActiveState=active", wantError: true},
		{name: "missing-property", output: "ActiveState=inactive\nMainPID=0", wantError: true},
		{name: "bad-pid", output: "ActiveState=inactive\nMainPID=01\nControlGroup=", wantError: true},
		{name: "overflow-pid", output: "ActiveState=inactive\nMainPID=4294967296\nControlGroup=", wantError: true},
		{name: "transitioning", output: "ActiveState=activating\nMainPID=0\nControlGroup=", wantError: true},
		{name: "surviving-pid", output: "ActiveState=inactive\nMainPID=42\nControlGroup=", wantError: true},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			reads := 0
			service := systemdBackupService{
				operatingSystem: contracts.RuntimeOperatingSystemLinux,
				run: func(ctx context.Context, executable string, args []string) ([]byte, error) {
					deadline, ok := ctx.Deadline()
					if !ok || time.Until(deadline) > systemdCheckTimeout || executable != "systemctl" || !reflect.DeepEqual(args, []string{"--user", "show", "dant-worker.service", "--property=ActiveState", "--property=MainPID", "--property=ControlGroup", "--no-pager"}) {
						t.Fatal("service inspection crossed its fixed command or deadline boundary")
					}
					return []byte(fixture.output), fixture.runError
				},
				readFile: func(name string) ([]byte, error) {
					reads++
					if name != "/sys/fs/cgroup/user.slice/dant-worker.service/cgroup.procs" {
						t.Fatal("service inspected an unrelated cgroup")
					}
					return []byte(fixture.members), fixture.readError
				},
			}
			running, err := service.Running(t.Context())
			if running != fixture.wantRunning || fixture.wantError != errors.Is(err, ErrBusy) {
				t.Fatal("unconfirmed service state was accepted or misclassified", running, err)
			}
			if running && reads != 0 {
				t.Fatal("active service was treated as an offline cgroup")
			}
		})
	}
}

func TestBackupServiceStartsOnlyWithAFixedBoundedCommandAndRetainsFailures(t *testing.T) {
	for _, fail := range []bool{false, true} {
		calls := 0
		service := systemdBackupService{operatingSystem: contracts.RuntimeOperatingSystemLinux, run: func(ctx context.Context, executable string, args []string) ([]byte, error) {
			calls++
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > systemdStartTimeout || executable != "systemctl" || !reflect.DeepEqual(args, []string{"--user", "start", "dant-worker.service"}) {
				t.Fatal("worker start crossed its fixed command boundary")
			}
			if fail {
				return nil, errors.New("synthetic private start failure")
			}
			return nil, nil
		}}
		err := service.Start(t.Context())
		if fail != errors.Is(err, ErrRestoreFailed) || calls != 1 {
			t.Fatal("failed worker start was retried or reported successful", err, calls)
		}
	}
	unsupported := systemdBackupService{operatingSystem: contracts.RuntimeOperatingSystemWindows}
	if running, err := unsupported.Running(t.Context()); running || !errors.Is(err, ErrRestoreFailed) {
		t.Fatal("unsupported host inspected systemd", err)
	}
	if err := unsupported.Start(t.Context()); !errors.Is(err, ErrRestoreFailed) {
		t.Fatal("unsupported host started systemd", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	service := newSystemdBackupService()
	if _, err := service.run(ctx, "must-not-start", nil); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled default command started a child", err)
	}
}
