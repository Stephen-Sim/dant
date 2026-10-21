package files_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type recoverySnapshotPersistence struct {
	*store.Store
	beforeSnapshot func()
}

func (value recoverySnapshotPersistence) Snapshot() contracts.State {
	value.beforeSnapshot()
	return value.Store.Snapshot()
}

func TestOutputRecoveryValidatesItsCapabilitiesAndSerializesCancelledAdmission(t *testing.T) {
	fixture := newRecoveryFixture(t, "[file](output/result.txt)")
	for _, invalid := range []files.RecoveryOptions{
		{Collector: fixture.collector, OutputDirectory: func() string { return fixture.output }},
		{Store: fixture.store, OutputDirectory: func() string { return fixture.output }},
		{Store: fixture.store, Collector: files.NewDeliverableCollector(nil, nil), OutputDirectory: func() string { return fixture.output }},
		{Store: fixture.store, Collector: fixture.collector},
	} {
		if _, err := files.NewRecovery(invalid); err == nil {
			t.Fatal("incomplete recovery capabilities were accepted")
		}
	}
	started, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	value, err := files.NewRecovery(files.RecoveryOptions{
		Store: fixture.store, Collector: fixture.collector,
		OutputDirectory: func() string { return fixture.output },
		ConversationTransaction: func(context.Context, string, func(context.Context) error) error {
			close(started)
			<-release
			return errors.New("isolated conversation no longer admitted")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := value.Resolve(t.Context(), "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt"))
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("first recovery did not acquire conversation admission")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := value.Resolve(cancelled, "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt")); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled second recovery acquired an occupied admission", err)
	}
	release <- struct{}{}
	select {
	case err := <-done:
		recoveryStatus(t, err, 409)
	case <-time.After(5 * time.Second):
		t.Fatal("refused recovery retained conversation admission")
	}

	reading, stop := context.WithCancel(t.Context())
	defer stop()
	value, err = files.NewRecovery(files.RecoveryOptions{
		Store: fixture.store, Collector: fixture.collector,
		OutputDirectory: func() string { return fixture.output },
		ConversationTransaction: func(context.Context, string, func(context.Context) error) error {
			stop()
			return errors.New("isolated owner cancelled")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := value.Resolve(reading, "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt")); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation during admission was replaced by a guessed conflict", err)
	}
	value, err = files.NewRecovery(files.RecoveryOptions{
		Store: fixture.store, Collector: fixture.collector, OutputDirectory: func() string { return "" },
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = value.Resolve(t.Context(), "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt"))
	recoveryStatus(t, err, 404)
}

func TestRecoveredSnapshotCannotBeReusedAfterMessageOrAttachmentOwnershipChanges(t *testing.T) {
	for _, phase := range []string{"message", "attachment", "duplicate", "missing-file"} {
		t.Run(phase, func(t *testing.T) {
			fixture := newRecoveryFixture(t, "[file](output/result.txt)")
			if err := os.WriteFile(filepath.Join(fixture.output, "result.txt"), []byte("authored output"), 0o600); err != nil {
				t.Fatal(err)
			}
			receipt, err := fixture.recovery(t).Resolve(t.Context(), "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt"))
			if err != nil {
				t.Fatal(err)
			}
			if phase == "missing-file" {
				if err := os.Remove(filepath.Join(fixture.attachments.Directory(), receipt.Attachment.ID+".json")); err != nil {
					t.Fatal(err)
				}
			}
			reads := 0
			observed := recoverySnapshotPersistence{Store: fixture.store, beforeSnapshot: func() {
				reads++
				if reads != 2 {
					return
				}
				if err := fixture.store.Mutate(t.Context(), func(state *contracts.State) error {
					message := state.Messages[0]
					switch phase {
					case "message":
						message.Text = "Changed authored message"
					case "attachment":
						message.Attachments[0].ID = "changed-attachment-identity"
					case "duplicate":
						message.Attachments = append(message.Attachments, message.Attachments[0])
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}}
			value, err := files.NewRecovery(files.RecoveryOptions{
				Store: observed, Collector: fixture.collector,
				OutputDirectory: func() string { return fixture.output },
				OnChange:        func() { fixture.changed.Add(1) },
			})
			if err != nil {
				t.Fatal(err)
			}
			_, err = value.Resolve(t.Context(), "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt"))
			status := 409
			if phase == "missing-file" {
				status = 404
			}
			recoveryStatus(t, err, status)
			if fixture.changed.Load() != 1 {
				t.Fatal("refused reuse published an extra conversation change")
			}
		})
	}
}

func TestOutputRecoveryRechecksAttachmentLimitsAndMessageIdentityAtCommit(t *testing.T) {
	for _, phase := range []string{"missing-message", "prior-snapshot", "duplicate-source", "capacity"} {
		t.Run(phase, func(t *testing.T) {
			fixture := newRecoveryFixture(t, "[file](output/result.txt)")
			path := filepath.Join(fixture.output, "result.txt")
			if err := os.WriteFile(path, []byte("authored output"), 0o600); err != nil {
				t.Fatal(err)
			}
			racing := recoveryRacingStore{Store: fixture.store, beforeCommit: func(ctx context.Context) error {
				return fixture.store.Mutate(ctx, func(state *contracts.State) error {
					message := state.Messages[0]
					switch phase {
					case "missing-message":
						state.Messages = []*contracts.ChatMessage{}
					case "prior-snapshot", "duplicate-source":
						message.Attachments = []contracts.Attachment{{ID: "different-snapshot", SourcePath: path}}
						if phase == "duplicate-source" {
							message.Attachments = append(message.Attachments, message.Attachments[0])
						}
					case "capacity":
						message.Attachments = make([]contracts.Attachment, files.MaxMessageAttachments)
						for index := range message.Attachments {
							message.Attachments[index].ID = "different-snapshot"
						}
					}
					return nil
				})
			}}
			value, err := files.NewRecovery(files.RecoveryOptions{
				Store: racing, Collector: fixture.collector,
				OutputDirectory: func() string { return fixture.output },
			})
			if err != nil {
				t.Fatal(err)
			}
			_, err = value.Resolve(t.Context(), "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt"))
			status := 409
			if phase == "missing-message" || phase == "duplicate-source" {
				status = 404
			}
			recoveryStatus(t, err, status)
		})
	}
}
