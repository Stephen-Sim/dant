package legacyimport

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/ownership"
)

func TestImportRejectsAnUnreadableManifestBeforeCreatingTheTarget(t *testing.T) {
	options := exportFixture(t, `{}`, nil)
	name := filepath.Join(options.SourceDir, manifestName)
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(name, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := Import(t.Context(), options); !errors.Is(err, ErrInvalid) {
		t.Fatal("non-regular manifest was treated as an absent optional export", err)
	}
	if _, err := os.Stat(options.TargetDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unreadable manifest created an authoritative import target")
	}
	if info, err := os.Stat(name); err != nil || !info.IsDir() {
		t.Fatal("invalid manifest validation replaced its source evidence", err)
	}
}

func TestCLIImportBusyFailureDoesNotPublishAResultOrChangeTheCurrentOwner(t *testing.T) {
	options := exportFixture(t, `{}`, nil)
	owner, err := ownership.Acquire(t.Context(), options.TargetDir)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	var output bytes.Buffer
	err = RunCLI(t.Context(), []string{"--source-dir", options.SourceDir, "--data-dir", options.TargetDir}, &output)
	if !errors.Is(err, ErrBusy) || output.Len() != 0 || !owner.Current() {
		t.Fatal("rejected CLI import published success or retired the active owner", err)
	}
	for _, name := range []string{stateName, journalName, receiptName, completionName} {
		if _, err := os.Stat(filepath.Join(options.TargetDir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("busy CLI import wrote authoritative state or import proof", name)
		}
	}
}

func TestImportCountsRepeatedAttachmentReferencesAcrossAllMessages(t *testing.T) {
	count := maxLegacyReferences/2 + 1
	references := strings.Repeat(`{"id":"same-missing-reference"},`, count-1) + `{"id":"same-missing-reference"}`
	message := `{"role":"assistant","attachments":[` + references + `]}`
	state := `{"messages":[` + message + `,` + message + `]}`
	options := exportFixture(t, state, nil)
	if _, err := Import(t.Context(), options); !errors.Is(err, ErrCapacity) {
		t.Fatal("deduplicated file identity bypassed the total reference bound", err)
	}
	if _, err := os.Stat(options.TargetDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("excessive references created target data before validation")
	}
	actual, err := os.ReadFile(filepath.Join(options.SourceDir, stateName))
	if err != nil || string(actual) != state {
		t.Fatal("capacity rejection changed the authored export", err)
	}
}
