package legacyimport

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestImportTransformationRejectsMalformedOwnedFieldsAndPreservesDispatchUncertainty(t *testing.T) {
	for _, input := range []string{
		`{"messages":false}`,
		`{"messages":[{"attachments":false}]}`,
		`{"messages":[{"role":"user","continuation":{"dispatch":false}}]}`,
		`{"workTasks":false}`,
		`{"workTasks":[{"continuation":false}]}`,
		`{"schedules":false}`,
		`{"callInputHistory":false}`,
		`{"settings":false}`,
	} {
		var state contracts.RawObject
		if json.Unmarshal([]byte(input), &state) != nil {
			t.Fatal("invalid isolated state fixture")
		}
		value := &source{state: state, manifest: contracts.RawObject{}}
		if _, err := value.transform(nil, nil); !errors.Is(err, ErrInvalid) {
			t.Fatal("malformed observed state acquired trusted runtime ownership", err)
		}
	}
	value := &source{manifest: contracts.RawObject{}, state: contracts.RawObject{"futureState": json.RawMessage(`{`)}}
	if _, err := value.transform(nil, nil); !errors.Is(err, ErrCapacity) {
		t.Fatal("unmarshalable preserved state was reported as transformed", err)
	}
	for _, mode := range []string{"missing-source", "missing-state", "invalid-state"} {
		options := exportFixture(t, `{}`, nil)
		switch mode {
		case "missing-source":
			options.SourceDir += "-missing"
		case "missing-state":
			if err := os.Remove(filepath.Join(options.SourceDir, stateName)); err != nil {
				t.Fatal(err)
			}
		case "invalid-state":
			if err := os.WriteFile(filepath.Join(options.SourceDir, stateName), []byte("false"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := Import(t.Context(), options); !errors.Is(err, ErrInvalid) {
			t.Fatal("missing or invalid source created trusted import state", err)
		}
		if _, err := os.Stat(options.TargetDir); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("source validation created destination data", err)
		}
	}
}

func TestImportArchivalRejectsChangedSourcesAndExistingAttachmentNamespace(t *testing.T) {
	for _, mode := range []string{"existing-directory", "changed-file", "closed-target"} {
		t.Run(mode, func(t *testing.T) {
			options := exportFixture(t, `{"messages":[{"attachments":[{"id":"one","name":"one.bin"}]}]}`, map[string][]byte{"one": {0, 1, 2}})
			value, err := readSource(t.Context(), options.SourceDir)
			if err != nil {
				t.Fatal(err)
			}
			defer value.root.Close()
			if err := os.Mkdir(options.TargetDir, 0o700); err != nil {
				t.Fatal(err)
			}
			target, err := openDestination(options.TargetDir)
			if err != nil {
				t.Fatal(err)
			}
			defer target.close()
			want := ErrUnconfirmed
			switch mode {
			case "existing-directory":
				if err := os.Mkdir(filepath.Join(options.TargetDir, "attachments"), 0o700); err != nil {
					t.Fatal(err)
				}
			case "changed-file":
				if err := os.WriteFile(filepath.Join(options.SourceDir, "files", "one"), []byte("changed bytes"), 0o600); err != nil {
					t.Fatal(err)
				}
				want = ErrChanged
			case "closed-target":
				_ = target.root.Close()
			}
			if _, _, _, err := value.archive(t.Context(), target, options.TargetDir); !errors.Is(err, want) {
				t.Fatal("uncertain archival operation was accepted", err)
			}
		})
	}
}

type importFailedWriter struct{}

func (importFailedWriter) Write([]byte) (int, error) { return 0, errors.New("isolated output failure") }

func TestImportTargetAndCLIOutputFailuresRemainExplicitAndDoNotRetry(t *testing.T) {
	options := exportFixture(t, `{}`, nil)
	if err := os.WriteFile(options.TargetDir, []byte("existing target file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Import(t.Context(), options); !errors.Is(err, ErrInvalid) {
		t.Fatal("non-directory target was accepted", err)
	}
	options = exportFixture(t, `{}`, nil)
	if err := RunCLI(t.Context(), []string{"--source-dir", options.SourceDir, "--data-dir", options.TargetDir}, importFailedWriter{}); err == nil {
		t.Fatal("failed result delivery was hidden")
	}
	if repeated, err := Import(t.Context(), options); err != nil || !repeated.Existing {
		t.Fatal("failed stdout delivery caused another import or lost its completed fence", err)
	}
	options = exportFixture(t, `{}`, nil)
	if err := os.Mkdir(options.TargetDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(options.TargetDir, receiptName), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Import(t.Context(), options); !errors.Is(err, ErrUnconfirmed) {
		t.Fatal("non-regular receipt acquired idempotency authority", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := Import(ctx, options); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled import lost its owner cancellation", err)
	}
}
