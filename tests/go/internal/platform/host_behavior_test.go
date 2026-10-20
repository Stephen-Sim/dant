package platform

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/i18n"
)

type hostProtectionFixture struct {
	calls int
}

func (protection *hostProtectionFixture) Protect(context.Context, []byte) ([]byte, error) {
	protection.calls++
	return nil, errors.New("fixture_must_not_be_called")
}

func (protection *hostProtectionFixture) Unprotect(context.Context, []byte) ([]byte, error) {
	protection.calls++
	return nil, errors.New("fixture_must_not_be_called")
}

func TestWindowsHostDefaultsAndInjectedProtectionDoNotExecuteAnything(t *testing.T) {
	protection := &hostProtectionFixture{}
	host, err := New("windows", nil, protection)
	if err != nil {
		t.Fatal(err)
	}
	if host.ID != contracts.HostPlatformIdWindows || host.OS != "windows" || host.Protection != protection {
		t.Fatal("host identity or supplied protection was replaced")
	}
	if !host.Capabilities.ManagedVM || !host.Capabilities.ExistingSSH || !host.Capabilities.SecretProtection || protection.calls != 0 {
		t.Fatal("constructing capabilities executed a protection operation")
	}

	configuration := host.Windows
	if configuration == nil || configuration.SystemDirectory != `C:\Windows\System32` || configuration.Archive != `C:\Windows\System32\tar.exe` {
		t.Fatal("Windows defaults do not use the selected system directory")
	}
	if configuration.HyperVService != `C:\Windows\System32\vmms.exe` || configuration.HyperVModule != `C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Hyper-V\Hyper-V.psd1` {
		t.Fatal("Hyper-V probes escaped their fixed system locations")
	}
	if !reflect.DeepEqual(configuration.VMwareDirectories, []string{`C:\Program Files (x86)\VMware\VMware Workstation`, `C:\Program Files\VMware\VMware Workstation`}) {
		t.Fatal("VMware discovery lost its fixed platform directories")
	}
	if host.Commands.PowerShell != "powershell.exe" || host.Commands.Registry != "reg.exe" || host.Commands.Archive != configuration.Archive {
		t.Fatal("platform commands are inconsistent with the selected host")
	}

	alias, err := New(string(contracts.HostPlatformIdWindows), nil, nil)
	if err != nil || alias.ID != host.ID || alias.Capabilities.SecretProtection {
		t.Fatal("the supported Windows platform identity lost its capabilities")
	}
}

func TestWindowsDirectoriesValidateEveryConfiguredRootAndRetainUNCPaths(t *testing.T) {
	for _, field := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
		t.Run(field, func(t *testing.T) {
			if _, err := New("windows", map[string]string{field: "relative\\directory"}, nil); !errors.Is(err, ErrHostConfiguration) {
				t.Fatal("an invalid configured platform root was accepted")
			}
		})
	}

	for _, fixture := range []struct {
		input string
		want  string
	}{
		{`D:/VMs/../Owned/./disk`, `D:\Owned\disk`},
		{`\\fixture-server\share\VMs\..\Owned`, `\\fixture-server\share\Owned`},
		{`/rooted/./fixture`, `\rooted\fixture`},
	} {
		actual, err := WindowsPath(fixture.input)
		if err != nil || actual != fixture.want {
			t.Fatal("absolute Windows path normalization changed its root", actual, err)
		}
	}
	for _, input := range []string{"", `C:relative`, `relative\directory`, "C:\\fixture\rcommand", "C:\\fixture\x00"} {
		if _, err := WindowsPath(input); !errors.Is(err, ErrHostConfiguration) {
			t.Fatal("a relative or control-containing Windows path was accepted")
		}
	}

	host, err := New("windows", map[string]string{
		"ProgramFiles":      `D:/Applications`,
		"ProgramFiles(x86)": `E:\Applications`,
		"FixtureRoot":       `\\fixture-server\share`,
		"FixtureChild":      "Owned",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := host.Windows.ExpandDirectory(`%FixtureRoot%\%FixtureChild%`)
	if err != nil || actual != `\\fixture-server\share\Owned` {
		t.Fatal("captured environment expansion changed a UNC root", actual, err)
	}
	if _, err := host.Windows.ExpandDirectory(`%UnknownFixture%\Owned`); !errors.Is(err, ErrHostConfiguration) {
		t.Fatal("an unresolved relative environment path became an absolute directory")
	}
	if !reflect.DeepEqual(host.Windows.VMwareDirectories, []string{`E:\Applications\VMware\VMware Workstation`, `D:\Applications\VMware\VMware Workstation`}) {
		t.Fatal("configured application directories were ignored")
	}
}

func TestSystemTimeZoneNeverReturnsAnUnvalidatedIdentity(t *testing.T) {
	zone, err := HostTimeZone(nil)
	if err != nil {
		if !errors.Is(err, ErrHostTimeZone) || zone != "" {
			t.Fatal("unavailable system timezone leaked a partial identity or native error")
		}
		return
	}
	canonical, valid := i18n.CanonicalTimeZone(zone)
	if !valid || canonical != zone {
		t.Fatal("system timezone bypassed shared canonical validation")
	}
}
