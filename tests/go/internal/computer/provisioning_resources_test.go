package computer

import (
	"context"
	"io"
	"path/filepath"
	"strconv"
	"testing"
	"time"
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
