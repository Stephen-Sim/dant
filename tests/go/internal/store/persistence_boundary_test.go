package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestStoreSubscriptionsAreBoundedCommitNotificationsWithJoinedIdempotentClosure(t *testing.T) {
	s, _ := openFixture(t)
	if s.Directory() == "" {
		t.Fatal("store omitted its dynamically configured directory")
	}
	changes, unsubscribe := s.Subscribe()
	for _, id := range []string{"first", "second"} {
		if _, err := s.Add(t.Context(), &contracts.ChatMessage{ID: id, Role: contracts.RoleAssistant, Text: "Committed result"}); err != nil {
			t.Fatal(err)
		}
	}
	if len(changes) != 1 {
		t.Fatal("commit notifications exceeded the subscriber's fixed bound")
	}
	<-changes
	if err := s.Mutate(t.Context(), func(*contracts.State) error { return ErrNoChange }); err != nil || len(changes) != 0 {
		t.Fatal("unchanged state emitted a new commit notification", err)
	}
	unsubscribe()
	unsubscribe()
	if _, open := <-changes; open {
		t.Fatal("unsubscribed notification channel remained open")
	}
	remaining, remove := s.Subscribe()
	s.Close()
	s.Close()
	remove()
	if _, open := <-remaining; open {
		t.Fatal("closed store did not close its subscriber")
	}
	closed, cancel := s.Subscribe()
	cancel()
	if _, open := <-closed; open {
		t.Fatal("closed store created a live subscription")
	}
}

func TestStoreOpeningFailsClosedBeforePublishingInvalidOrUnwritableState(t *testing.T) {
	for _, kind := range []string{"cancelled", "occupied directory", "state directory", "corrupt state", "invalid identity", "failed write"} {
		t.Run(kind, func(t *testing.T) {
			directory := t.TempDir()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			options := Options{}
			switch kind {
			case "cancelled":
				cancel()
			case "occupied directory":
				directory = filepath.Join(directory, "occupied")
				if err := os.WriteFile(directory, nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "state directory":
				if err := os.Mkdir(filepath.Join(directory, stateFileName), 0700); err != nil {
					t.Fatal(err)
				}
			case "corrupt state":
				if err := os.WriteFile(filepath.Join(directory, stateFileName), []byte(`null`), 0600); err != nil {
					t.Fatal(err)
				}
			case "invalid identity":
				options.NewID = func() string { return "invalid" }
			case "failed write":
				options.Write = func(context.Context, string, []byte, fs.FileMode) error {
					return errors.New("isolated atomic write failure")
				}
			}
			if value, err := OpenContext(ctx, directory, options); err == nil || value != nil {
				t.Fatal("invalid or uncommitted store was published", kind)
			}
		})
	}
}

func TestMutationRejectsMissingOrInvalidDiskAndUnserializableChangesWithoutPartialCommit(t *testing.T) {
	for _, kind := range []string{"nil change", "missing disk", "corrupt disk", "invalid raw field", "invalid typed field", "invalid no-change", "cancelled during change"} {
		t.Run(kind, func(t *testing.T) {
			s, directory := openFixture(t)
			file := filepath.Join(directory, stateFileName)
			before, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			change := func(state *contracts.State) error {
				switch kind {
				case "invalid raw field", "invalid no-change":
					state.Extra = contracts.RawObject{"invalid": json.RawMessage(`{`)}
					if kind == "invalid no-change" {
						return ErrNoChange
					}
				case "invalid typed field":
					state.Messages = append(state.Messages, &contracts.ChatMessage{ID: "invalid", Role: contracts.RoleUser, Status: contracts.Some(contracts.MessageStatus("foreign"))})
				case "cancelled during change":
					state.Memory = "Must not commit"
					cancel()
				}
				return nil
			}
			switch kind {
			case "nil change":
				change = nil
			case "missing disk":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
			case "corrupt disk":
				if err := os.WriteFile(file, []byte(`null`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.Mutate(ctx, change); err == nil || s.Revision() != 0 || s.Snapshot().Memory != "" || len(s.Snapshot().Messages) != 0 {
				t.Fatal("rejected mutation changed in-memory authority", kind, err)
			}
			if kind != "missing disk" && kind != "corrupt disk" {
				after, err := os.ReadFile(file)
				if err != nil || !bytes.Equal(before, after) {
					t.Fatal("failed mutation changed persisted bytes", kind, err)
				}
			}
		})
	}
}

func TestVisibleReceiptsMarkOnlyCompletionsWhoseEveryResultWasRead(t *testing.T) {
	s, _, _, _ := progressFixture(t)
	if err := s.Mutate(t.Context(), func(state *contracts.State) error {
		state.Completions = append(state.Completions,
			contracts.Completion{ID: "missing result", TurnID: "other", MessageIDs: []string{"missing"}},
			contracts.Completion{ID: "empty result", TurnID: "empty"},
		)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkVisible(t.Context(), []string{"task"}, nil); err != nil {
		t.Fatal(err)
	}
	if s.Snapshot().Completions[0].ReadAt.Value != 0 {
		t.Fatal("unread assistant result became a read completion")
	}
	if err := s.MarkVisible(t.Context(), []string{"answer"}, nil); err != nil {
		t.Fatal(err)
	}
	state := s.Snapshot()
	if state.Completions[0].ReadAt.Value != s.Timestamp() || state.Completions[1].ReadAt.Value != 0 || state.Completions[2].ReadAt.Value != 0 {
		t.Fatal("receipt invented visibility for a missing or empty result")
	}
}
