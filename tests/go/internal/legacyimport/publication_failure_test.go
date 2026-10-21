package legacyimport

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/ownership"
)

func importPublicationFixture(t *testing.T) (Options, *source, *destination, *ownership.Lock) {
	t.Helper()
	options := exportFixture(t, `{"messages":[{"attachments":[{"id":"file","name":"kept.bin"}]}]}`, map[string][]byte{"file": {0, 1, 255}})
	value, err := readSource(t.Context(), options.SourceDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = value.root.Close() })
	owner, err := ownership.Acquire(t.Context(), options.TargetDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = owner.Close() })
	target, err := openDestination(options.TargetDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(target.close)
	return options, value, target, owner
}

func TestImportPublicationStopsAtEachFailedDurableBoundaryAndNeverReplaysUnconfirmedWrites(t *testing.T) {
	order := []string{journalName, originalManifestName, originalStateName, stateName, receiptName, completionName}
	for failureIndex, failed := range order {
		for _, durable := range []bool{false, true} {
			mode := "unwritten"
			if durable {
				mode = "durable-but-unconfirmed"
			}
			t.Run(failed+"/"+mode, func(t *testing.T) {
				options, value, target, owner := importPublicationFixture(t)
				denied := errors.New("synthetic publication result is unconfirmed")
				calls, written := []string{}, map[string]string{}
				publish := func(ctx context.Context, name string, data []byte) error {
					calls = append(calls, name)
					if name != failed || durable {
						if err := target.exclusive(ctx, name, data); err != nil {
							return err
						}
						written[name] = string(data)
					}
					if name == failed {
						return denied
					}
					return nil
				}
				result, err := value.publishImport(t.Context(), options, target, func() error { return value.unchanged(t.Context()) }, publish)
				if !errors.Is(err, denied) || result.OK || !reflect.DeepEqual(calls, order[:failureIndex+1]) {
					t.Fatal("publication error was hidden, reordered, or retried", calls, err)
				}
				for name, expected := range written {
					actual, err := os.ReadFile(filepath.Join(options.TargetDir, name))
					if err != nil || string(actual) != expected {
						t.Fatal("failed publication replaced earlier durable evidence", name, err)
					}
				}
				if !durable {
					if _, err := os.Stat(filepath.Join(options.TargetDir, failed)); !errors.Is(err, os.ErrNotExist) {
						t.Fatal("unwritten publication created the failed file", err)
					}
				}
				if original, err := os.ReadFile(filepath.Join(options.SourceDir, stateName)); err != nil || string(original) != string(value.stateRaw) {
					t.Fatal("failed publication changed its original source", err)
				}
				if err := owner.Close(); err != nil {
					t.Fatal(err)
				}
				if durable && failed == completionName {
					// Reconciliation of complete independent proof may acknowledge
					// the completed import, but may not publish a second attempt.
					if existing, err := Import(t.Context(), options); err != nil || !existing.Existing {
						t.Fatal("complete proof did not reconcile an uncertain final return", err)
					}
				} else if failureIndex > 0 || durable {
					if _, err := Import(t.Context(), options); !errors.Is(err, ErrUnconfirmed) {
						t.Fatal("incomplete durable attempt was replayed", err)
					}
				}
				for name, expected := range written {
					actual, err := os.ReadFile(filepath.Join(options.TargetDir, name))
					if err != nil || string(actual) != expected {
						t.Fatal("reconciliation changed an existing durable publication", name, err)
					}
				}
			})
		}
	}
}

func TestImportPublicationVerifiesArchiveSourceAndOutputBeforeCompletion(t *testing.T) {
	for _, mode := range []string{"archive", "source-before-state", "source-before-completion", "output-before-completion"} {
		t.Run(mode, func(t *testing.T) {
			options, value, target, _ := importPublicationFixture(t)
			completed := false
			publish := func(ctx context.Context, name string, data []byte) error {
				if name == completionName {
					completed = true
				}
				if err := target.exclusive(ctx, name, data); err != nil {
					return err
				}
				switch {
				case mode == "archive" && name == originalStateName:
					return os.Mkdir(filepath.Join(options.TargetDir, "attachments"), 0o700)
				case mode == "source-before-state" && name == originalStateName, mode == "source-before-completion" && name == receiptName:
					return os.WriteFile(filepath.Join(options.SourceDir, stateName), []byte("changed synthetic source"), 0o600)
				case mode == "output-before-completion" && name == receiptName:
					return os.WriteFile(filepath.Join(options.TargetDir, stateName), []byte("changed synthetic output"), 0o600)
				}
				return nil
			}
			result, err := value.publishImport(t.Context(), options, target, func() error { return value.unchanged(t.Context()) }, publish)
			if err == nil || result.OK || completed {
				t.Fatal("unverified archival or source evidence received a completion marker", err)
			}
			if _, err := os.Stat(filepath.Join(options.TargetDir, completionName)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("failed validation retained a completion marker", err)
			}
		})
	}
}
