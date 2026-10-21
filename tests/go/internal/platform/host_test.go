package platform

import (
	"context"
	"errors"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestHostCapabilitiesAndCapturedWindowsPaths(t *testing.T) {
	environment := map[string]string{"SystemRoot": `D:\Windows`, "ProgramFiles": `E:\Fixture Programs`, "ProgramFiles(x86)": `F:\Fixture Programs`, "Tools": `D:\Tools`}
	host, err := New("windows", environment, nil)
	if err != nil || host.ID != contracts.HostPlatformIdWindows || !host.Capabilities.ManagedVM || !host.Capabilities.ExistingSSH {
		t.Fatalf("Windows capabilities: %+v, %v", host.Capabilities, err)
	}

	if host.Windows.PowerShell != `D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` {
		t.Fatal("PowerShell must use captured system root")
	}
	environment["Tools"] = `C:\Changed`
	if expanded, err := host.Windows.ExpandDirectory(`%Tools%\VMware`); err != nil || expanded != `D:\Tools\VMware` {
		t.Fatal("environment must be captured rather than consulted later")
	}
	for _, goos := range []string{"linux", "darwin", "other"} {
		host, err := New(goos, nil, nil)
		if err != nil || host.Windows != nil || host.Capabilities.ManagedVM || host.Commands.PowerShell != "" || host.Capabilities.ExistingSSH != (goos != "other") {
			t.Fatalf("unexpected capabilities for %s", goos)
		}
	}
}

func TestHostConfigurationRejectsUnsafePathsAndCommandsAreNotStarted(t *testing.T) {
	for _, value := range []string{"relative", "C:\\Windows\ncommand", "C:\\Windows\x00"} {
		if _, err := New("windows", map[string]string{"SystemRoot": value}, nil); !errors.Is(err, ErrHostConfiguration) {
			t.Fatal("unsafe host directory accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Run(ctx, "never-launched-fixture", nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled child must not start")
	}
	output := &limitedOutput{limit: 3}
	if _, err := output.Write([]byte("four")); !errors.Is(err, ErrCommandOutputLimit) || len(output.bytes) != 0 {
		t.Fatal("process output must be bounded")
	}
}
