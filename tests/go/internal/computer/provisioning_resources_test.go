package computer

import (
	"context"
	"io"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/config"
)

func TestProvisioningResourceDefaultsAndExplicitLargerSizesReachEachProvider(t *testing.T) {
	for _, provider := range []string{"hyperv", "vmware"} {
		for _, custom := range []bool{false, true} {
			t.Run(provider+"/custom="+strconv.FormatBool(custom), func(t *testing.T) {
				options := provisioningContractOptions(t)
				created := make(chan []string, 1)
				options.Run = func(_ context.Context, _ string, args []string, _ io.Reader) ([]byte, error) {
					for _, arg := range args {
						if name := filepath.Base(arg); name == "launch-vm.ps1" || name == "create-vmware.ps1" {
							created <- append([]string(nil), args...)
							return nil, ErrProvisioningFailed
						}
					}
					return nil, nil
				}

				provisioning, err := NewProvisioning(options)
				if err != nil {
					t.Fatal(err)
				}
				defer provisioning.Close()

				raw := `{"provider":"` + provider + `"}`
				cpu, memory, disk := "4", "8", "64"
				if custom {
					raw = `{"provider":"` + provider + `","cpu":12,"memoryGB":16,"diskGB":128}`
					cpu, memory, disk = "12", "16", "128"
				}
				if _, err := provisioning.Start(t.Context(), []byte(raw)); err != nil {
					t.Fatal(err)
				}

				select {
				case args := <-created:
					for option, want := range map[string]string{"-Cpu": cpu, "-MemoryGB": memory, "-DiskGB": disk} {
						found := false
						for index, arg := range args {
							if arg == option && index+1 < len(args) {
								found = args[index+1] == want
							}
						}
						if !found {
							t.Fatalf("provider helper did not retain %s=%s", option, want)
						}
					}
				case <-time.After(5 * time.Second):
					t.Fatal("isolated provider helper was not called")
				}
			})
		}
	}
}

func TestProvisioningConsumesChangedCanonicalDefaultsAndInclusiveRanges(t *testing.T) {
	resources, err := config.ParseComputerResources([]byte(`{"cpu":{"default":7,"min":3,"max":11},"memoryGB":{"default":19,"min":5,"max":29},"diskGB":{"default":137,"min":73,"max":257}}`))
	if err != nil {
		t.Fatal(err)
	}
	request, err := parseSetupRequest([]byte(`{}`), resources)
	if err != nil || request.CPU != 7 || request.MemoryGB != 19 || request.DiskGB != 137 || request.Provider != "auto" {
		t.Fatal("provisioning did not consume changed canonical defaults")
	}
	for _, raw := range []string{
		`{"cpu":3,"memoryGB":5,"diskGB":73}`,
		`{"cpu":11,"memoryGB":29,"diskGB":257}`,
	} {
		if _, err := parseSetupRequest([]byte(raw), resources); err != nil {
			t.Fatal("inclusive configured limit was rejected")
		}
	}
	for _, raw := range []string{
		`{"cpu":2}`, `{"cpu":12}`, `{"memoryGB":4}`, `{"memoryGB":30}`,
		`{"diskGB":72}`, `{"diskGB":258}`, `{"cpu":null}`, `{"cpu":7.5}`,
		`{"cpu":true}`, `{"cpu":"7"}`, `{"cpu":7,"cpu":8}`, `{"unknown":1}`,
	} {
		if _, err := parseSetupRequest([]byte(raw), resources); err == nil {
			t.Fatal("invalid or out-of-policy provisioning request accepted")
		}
	}
}
