package legacyimport

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func capturedImport(t *testing.T) (Options, *source, *destination, journal, importProof, []byte) {
	t.Helper()
	options := exportFixture(t, `{"messages":[{"role":"assistant","attachments":[{"id":"file","name":"receipt.bin"}]}]}`, map[string][]byte{"file": {0, 1, 255}})
	if _, err := Import(t.Context(), options); err != nil {
		t.Fatal(err)
	}
	value, err := readSource(t.Context(), options.SourceDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = value.root.Close() })
	target, err := openDestination(options.TargetDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(target.close)
	intentRaw, err := os.ReadFile(filepath.Join(options.TargetDir, journalName))
	if err != nil {
		t.Fatal(err)
	}
	receiptRaw, err := os.ReadFile(filepath.Join(options.TargetDir, receiptName))
	if err != nil {
		t.Fatal(err)
	}
	var intent journal
	var receipt struct {
		Proof importProof `json:"proof"`
	}
	if json.Unmarshal(intentRaw, &intent) != nil || json.Unmarshal(receiptRaw, &receipt) != nil {
		t.Fatal("completed isolated receipt was unreadable")
	}
	return options, value, target, intent, receipt.Proof, receiptRaw
}

func TestExistingImportRejectsMalformedReceiptAndUnconfirmedProofWithoutRewritingState(t *testing.T) {
	for _, mode := range []string{"object", "identity", "proof", "journal", "completion", "output", "source"} {
		t.Run(mode, func(t *testing.T) {
			options, value, target, _, _, receipt := capturedImport(t)
			stateBefore, _ := os.ReadFile(filepath.Join(options.TargetDir, stateName))
			want := ErrUnconfirmed
			switch mode {
			case "object":
				receipt = []byte("false")
			case "identity":
				receipt = []byte(`{"id":"other-import"}`)
				want = ErrConflict
			case "proof":
				receipt = []byte(`{"id":"one-import","proof":{}}`)
			case "journal":
				if err := os.WriteFile(filepath.Join(options.TargetDir, journalName), []byte(`{"changed":"journal"}`), 0o600); err != nil {
					t.Fatal(err)
				}
			case "completion":
				if err := os.WriteFile(filepath.Join(options.TargetDir, completionName), []byte(`{"changed":"completion"}`), 0o600); err != nil {
					t.Fatal(err)
				}
			case "output":
				if err := os.WriteFile(filepath.Join(options.TargetDir, originalStateName), []byte("changed archived evidence"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "source":
				if err := os.WriteFile(filepath.Join(options.SourceDir, manifestName), []byte(`{"id":"changed-source"}`), 0o600); err != nil {
					t.Fatal(err)
				}
				want = ErrChanged
			}
			if _, err := value.existing(t.Context(), options, target, receipt); !errors.Is(err, want) {
				t.Fatal("unconfirmed existing import acquired idempotency authority", err)
			}
			stateAfter, _ := os.ReadFile(filepath.Join(options.TargetDir, stateName))
			if string(stateAfter) != string(stateBefore) {
				t.Fatal("failed receipt verification rewrote imported history")
			}
		})
	}
}

func TestImportOutputProofRejectsMissingDuplicatedMismatchedAndChangedAttachmentEvidence(t *testing.T) {
	for _, mode := range []string{"count", "legacy-id", "uuid", "bytes", "metadata-digest", "file-bytes", "metadata-fields"} {
		t.Run(mode, func(t *testing.T) {
			options, value, target, intent, proof, _ := capturedImport(t)
			switch mode {
			case "count":
				proof.Files = nil
			case "legacy-id":
				proof.Files[0].LegacyID = "not-the-saved-reference"
			case "uuid":
				proof.Files[0].ID = "not-a-v4-id"
			case "bytes":
				proof.Files[0].Bytes++
			case "metadata-digest":
				proof.Files[0].MetadataSHA256 = strings.Repeat("0", 64)
			case "file-bytes":
				if err := os.WriteFile(filepath.Join(options.TargetDir, "attachments", proof.Files[0].ID+".bin"), []byte("changed saved attachment"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "metadata-fields":
				file := filepath.Join(options.TargetDir, "attachments", proof.Files[0].ID+".json")
				raw, err := os.ReadFile(file)
				if err != nil {
					t.Fatal(err)
				}
				var attachment contracts.Attachment
				if json.Unmarshal(raw, &attachment) != nil {
					t.Fatal("isolated attachment metadata invalid")
				}
				attachment.GuestPath = filepath.Join(t.TempDir(), "unowned.bin")
				raw = wire(attachment)
				if err := os.WriteFile(file, raw, 0o600); err != nil {
					t.Fatal(err)
				}
				proof.Files[0].MetadataSHA256 = hash(raw)
			}
			if err := value.verifyOutputs(t.Context(), options, target, intent, proof); !errors.Is(err, ErrUnconfirmed) {
				t.Fatal("unconfirmed output proof was accepted", err)
			}
		})
	}
	options, value, target, intent, proof, _ := capturedImport(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := value.verifyOutputs(ctx, options, target, intent, proof); !errors.Is(err, ErrUnconfirmed) && !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled output verification succeeded", err)
	}
}
