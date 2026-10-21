package memory

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestMissingMemoryRevisionFailsManagementAndRecallWithoutChangingNotes(t *testing.T) {
	s := openStoreFixture(t)
	if err := s.WriteNote(t.Context(), "identity.md", "Synthetic retained identity"); err != nil {
		t.Fatal(err)
	}
	memoryFixtureSQL(t, s, "DELETE FROM memory_meta WHERE id=1")

	if _, err := s.ManagementSnapshot(t.Context()); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("missing revision produced a management snapshot", err)
	}
	if _, err := s.ManageForConversation(t.Context(), "conversation", Mutation{}, nil); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("missing revision admitted a conversation mutation", err)
	}
	if _, err := s.Manage(t.Context(), Mutation{}); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("missing revision admitted a memory mutation", err)
	}
	if _, err := s.Context(t.Context(), true); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("missing revision produced reusable context", err)
	}
	if results, err := s.Search(t.Context(), "retained", SearchOptions{Limit: 10}); !errors.Is(err, ErrInvalidSnapshot) || len(results) != 0 {
		t.Fatal("missing revision produced recall references", err)
	}
	if text, err := s.ReadNote(t.Context(), "identity.md"); err != nil || text != "Synthetic retained identity" {
		t.Fatal("failed revision checks changed canonical notes", err)
	}
}

func TestMemoryTransactionCancellationRejectsEntryAndConflictQueries(t *testing.T) {
	for _, conflicts := range []bool{false, true} {
		t.Run(map[bool]string{false: "entries", true: "conflicts"}[conflicts], func(t *testing.T) {
			s := openStoreFixture(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			err := s.transaction(ctx, false, func(tx *sql.Tx) error {
				cancel()
				if conflicts {
					result, err := conflictsAt(ctx, tx, "semantic", "synthetic-key", "ignored-id")
					if len(result) != 0 {
						t.Fatal("cancelled conflict query yielded partial identities")
					}
					return err
				}
				result, err := entriesAt(ctx, tx, contracts.MemoryEntryStatusConfirmed)
				if len(result) != 0 {
					t.Fatal("cancelled entry query yielded partial records")
				}
				return err
			})
			if !errors.Is(err, context.Canceled) {
				t.Fatal("cancelled memory query lost its classified cancellation", err)
			}
			if entries, err := s.Entries(t.Context(), contracts.MemoryEntryStatusConfirmed); err != nil || len(entries) != 0 {
				t.Fatal("cancelled memory query changed durable entries", err)
			}
		})
	}
}

func TestMemoryManagementSearchFailureAndNonmatchingEntriesStayInvisible(t *testing.T) {
	s := openStoreFixture(t)
	entry, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Text: "Synthetic retained preference", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.ManagementPage(t.Context(), "conversation", "absentneedle", 0, nil)
	if err != nil || page.Total != 0 || len(page.Records) != 0 {
		t.Fatal("nonmatching candidate leaked into filtered management results", err)
	}
	memoryFixtureSQL(t, s, "DROP TABLE memory_search")
	if _, err := s.ManagementPage(t.Context(), "conversation", "needle", 0, nil); !errors.Is(err, ErrUnavailable) {
		t.Fatal("failed management search became a successful empty result", err)
	}
	entries, err := s.Entries(t.Context(), contracts.MemoryEntryStatusCandidate)
	if err != nil || len(entries) != 1 || entries[0].ID != entry.ID {
		t.Fatal("failed management search changed retained candidates", err)
	}
}

func TestLegacyProjectImportKeepsExistingProjectsAndRejectsUnencodableData(t *testing.T) {
	s := openStoreFixture(t)
	raw := json.RawMessage(`{"version":1,"updatedAt":1000,"originalRequest":{"messageId":"request","at":1000,"text":"Retained project","attachments":[]},"humanUpdates":[],"results":[]}`)
	if _, err := s.WriteProject(t.Context(), "conversation", "work", raw); err != nil {
		t.Fatal(err)
	}
	if err := s.MigrateProjects(t.Context(), "conversation", []contracts.WorkRecord{{ID: "work", ProjectContext: contracts.RawObject{"version": json.RawMessage(`false`)}}}); err != nil {
		t.Fatal("startup replaced an existing project authority", err)
	}
	if err := s.MigrateProjects(t.Context(), "conversation", []contracts.WorkRecord{{ID: "new-work", ProjectContext: contracts.RawObject{"version": json.RawMessage(`{`)}}}); !errors.Is(err, ErrInvalidMemory) {
		t.Fatal("unencodable project data was imported", err)
	}
	project, err := s.ReadProject(t.Context(), "conversation", "work")
	if err != nil || project.OriginalRequest == nil || project.OriginalRequest.Text != "Retained project" {
		t.Fatal("failed legacy import modified its previous project", err)
	}
}

func TestLegacyMemoryBackupPreservesOriginalUTF16BeforeAdoptingItsDecodedText(t *testing.T) {
	s := openStoreFixture(t)
	fixture := &legacyStateFixture{state: contracts.State{
		ConversationID: "conversation",
		Memory:         "Synthetic legacy \ufffd text",
		LegacyText:     contracts.LegacyJSON{Original: contracts.RawObject{"memory": json.RawMessage(`"Synthetic legacy \ud800 text"`)}},
	}}
	if err := s.MigrateLegacy(t.Context(), fixture); err != nil {
		t.Fatal(err)
	}
	backups, err := filepath.Glob(filepath.Join(s.Directory(), "legacy-state-backup-*", "memory.json"))
	if err != nil || len(backups) != 1 {
		t.Fatal("legacy backup was not persisted before adoption", err)
	}
	raw, err := os.ReadFile(backups[0])
	if err != nil || !strings.Contains(string(raw), `\ud800`) || fixture.state.Memory != "Synthetic legacy \ufffd text" {
		t.Fatal("original UTF-16 backup was replaced by repaired text", err)
	}
}

func TestMemoryQueryNormalizationBoundsSingleCJKAndSplitUTF16Input(t *testing.T) {
	prepared, err := PrepareSearch("汉")
	if err != nil || len(prepared.Terms) != 1 || prepared.Terms[0] != "汉" {
		t.Fatal("single CJK character disappeared from prepared search", err)
	}
	prepared, err = PrepareRetrieval(strings.Repeat(" ", 32767) + "😀")
	if err != nil || len(prepared.Terms) != 0 {
		t.Fatal("bounded UTF-16 truncation created a spurious search term", err)
	}
	text := "isolated " + strings.Repeat("x ", 300) + "cluster-alpha cluster-beta"
	excerpt, ok := relevantExcerpt(text, normalizeText(text), []string{"isolated", "cluster-alpha", "cluster-beta"}, 256)
	if !ok || !strings.Contains(stringFromUnits(excerpt.units), "cluster-alpha") || strings.Contains(stringFromUnits(excerpt.units), "isolated") {
		t.Fatal("recall excerpt ignored its stronger relevant cluster")
	}
}

func TestMemorySanitizerHandlesEscapedAndUnclosedQuotedAssignments(t *testing.T) {
	for _, text := range []string{`password="synthetic\"secret" public`, "password='synthetic unterminated", "password= public", "password="} {
		safe := SanitizeText(text)
		if strings.Contains(safe, "synthetic") || strings.Contains(safe, "unterminated") || strings.Contains(safe, "secret\"") {
			t.Fatal("quoted credential fragments remained in reference text")
		}
		if SanitizeText(safe) != safe {
			t.Fatal("sanitization changed previously sanitized reference text")
		}
	}
}

func TestEditingCandidateToAConfirmedKeyRetainsTheConflictInsteadOfGrantingAuthority(t *testing.T) {
	s := openStoreFixture(t)
	prior, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Key: ptr("preference"), Text: "Synthetic confirmed choice", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Confirm(t.Context(), prior.ID, false); err != nil {
		t.Fatal(err)
	}
	candidate, err := s.Propose(t.Context(), Proposal{Kind: "semantic", Key: ptr("unrelated"), Text: "Synthetic proposed alternative", Source: Source{Kind: "user"}})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := s.Update(t.Context(), candidate.ID, EntryPatch{"key": json.RawMessage(`"preference"`)})
	if err != nil || updated.Status != contracts.MemoryEntryStatusConflicted || len(updated.ConflictsWith) != 1 || updated.ConflictsWith[0] != prior.ID {
		t.Fatal("candidate edit overrode an existing confirmed preference", err)
	}
	confirmed, err := s.Entries(t.Context(), contracts.MemoryEntryStatusConfirmed)
	if err != nil || len(confirmed) != 1 || confirmed[0].ID != prior.ID || confirmed[0].Text != prior.Text {
		t.Fatal("candidate edit changed confirmed memory authority", err)
	}
}
