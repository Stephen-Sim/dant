package backups

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestScopedJournalSupportsLargeLibrariesWithinBoundedArchiveLimits(t *testing.T) {
	original := directoryID{Dev: "1", Ino: "1"}
	journal := restoreJournal{
		SchemaVersion: scopedRestoreJournalVersion,
		Scope:         AgentDataScope,
		RestoreID:     testRestoreID,
		Phase:         contracts.WorkerRestorePhasePrepared,
		Components: []scopedRestoreComponent{{
			Domain:   "data",
			Original: &original,
			Incoming: directoryID{Dev: "1", Ino: "2"},
			Parents:  []directoryID{{Dev: "1", Ino: "3"}},
		}},
	}
	for index := 0; index < 4096; index++ {
		journal.Components = append(journal.Components, scopedRestoreComponent{
			Domain:   "workspace",
			Path:     fmt.Sprintf("%08x-c8c5-4f6e-a7d8-531530d09479", index),
			Incoming: directoryID{Dev: "1", Ino: fmt.Sprint(index + 10)},
			Parents:  []directoryID{{Dev: "1", Ino: "4"}},
		})
	}
	name := filepath.Join(t.TempDir(), "journal.json")
	if err := writeRestoreJSON(t.Context(), name, journal); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(name)
	if err != nil || info.Size() <= restoreJournalMaxBytes || info.Size() >= scopedRestoreJournalMaxBytes {
		t.Fatal("large valid scoped journal did not use its bounded budget", err)
	}
	loaded, err := readJournal(name)
	if err != nil || loaded == nil || len(loaded.Components) != 4097 {
		t.Fatal("valid archive-scale library list cannot be recovered", err)
	}
	if err := clearRestoreJSONFile(name, scopedRestoreJournalMaxBytes); err != nil {
		t.Fatal("large committed journal cannot be cleaned", err)
	}
	journal.Components = make([]scopedRestoreComponent, maxScopedRestoreComponents+1)
	if validScopedRestoreJournal(journal) {
		t.Fatal("journal exceeded the archive entry bound")
	}
}

func TestScopedJournalBudgetCoversMaximumSerializedComponent(t *testing.T) {
	identity := directoryID{Dev: strings.Repeat("9", 40), Ino: strings.Repeat("9", 40)}
	component := scopedRestoreComponent{
		Domain:   "workspace",
		Path:     scopedExistingID + "/.agents/skills",
		Original: &identity,
		Incoming: identity,
		Parents:  []directoryID{identity, identity, identity},
	}
	raw, err := json.Marshal(component)
	if err != nil || (len(raw)+1)*maxScopedRestoreComponents+1024 > scopedRestoreJournalMaxBytes {
		t.Fatal("maximum archive component list cannot fit the journal budget", err)
	}
}

func TestScopedJournalRejectsOversizeBeforeReadingAndKeepsLegacyBudget(t *testing.T) {
	name := filepath.Join(t.TempDir(), "journal.json")
	file, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(scopedRestoreJournalMaxBytes + 1); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := readJournal(name); !errors.Is(err, ErrRestoreFailed) {
		t.Fatal("oversized journal was read or accepted", err)
	}
	identity := directoryID{Dev: "1", Ino: "1"}
	legacy := restoreJournal{RestoreID: testRestoreID, Phase: contracts.WorkerRestorePhasePrepared, Data: identity, Workspace: identity}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, []byte(strings.Repeat(" ", restoreJournalMaxBytes))...)
	if err := os.WriteFile(name, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readJournal(name); !errors.Is(err, ErrRestoreFailed) {
		t.Fatal("legacy journal silently adopted the larger scoped budget", err)
	}
}
