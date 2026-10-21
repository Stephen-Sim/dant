package computer

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestDeploymentMissingAttemptFieldsCannotReplayAPreviouslyUnknownUpload(t *testing.T) {
	for _, raw := range []string{
		`{}`,
		`{"schemaVersion":1}`,
		`{"entries":[]}`,
		`{"schemaVersion":null,"entries":[]}`,
		`{"schemaVersion":1,"entries":null}`,
		`{"schemaVersion":"1","entries":[]}`,
		`{"schemaVersion":1,"entries":{}}`,
	} {
		t.Run(raw, func(t *testing.T) {
			options, binding, manifest, _ := deploymentContractOptions(t)
			uploads := 0
			options.Run = func(_ context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
				if input != nil {
					uploads++
					return nil, io.ErrUnexpectedEOF
				}
				return obsoleteDeploymentProof(t, manifest), nil
			}
			deployer, err := NewDeployer(options)
			if err != nil {
				t.Fatal(err)
			}
			if err := deployer.Prepare(t.Context(), binding); !errors.Is(err, ErrDeploymentUnconfirmed) || uploads != 1 {
				t.Fatal("fixture did not retain its unknown installation outcome", err)
			}
			name := filepath.Join(options.DataDir, "vm-update-attempts.json")
			before, err := os.ReadFile(name)
			if err != nil || len(before) == 0 {
				t.Fatal("unknown upload had no durable pending attempt", err)
			}
			if err := os.WriteFile(name, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}

			if err := deployer.Prepare(t.Context(), binding); !errors.Is(err, ErrDeploymentUnconfirmed) || uploads != 1 {
				t.Fatalf("incomplete attempt history replayed an unknown upload: uploads=%d error=%v", uploads, err)
			}
			if after, err := os.ReadFile(name); err != nil || string(after) != raw {
				t.Fatal("reconciliation overwrote incomplete attempt evidence", err)
			}
		})
	}
}
