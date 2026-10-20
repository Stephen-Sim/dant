package files_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type recoveryFixture struct {
	store       *store.Store
	attachments *files.AttachmentStore
	collector   *files.DeliverableCollector
	output      string
	changed     atomic.Int32
	failWrite   atomic.Bool
}

func newRecoveryFixture(t *testing.T, text string) *recoveryFixture {
	t.Helper()
	root := t.TempDir()
	fixture := &recoveryFixture{output: filepath.Join(root, "output")}
	var err error
	fixture.store, err = store.Open(filepath.Join(root, "data"), store.Options{
		Write: func(ctx context.Context, path string, data []byte, mode fs.FileMode) error {
			if fixture.failWrite.Load() {
				return errors.New("private fixture storage error")
			}
			return files.WriteAtomic(ctx, path, data, mode)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(fixture.store.Close)
	fixture.attachments, err = files.OpenAttachmentStore(filepath.Join(root, "attachments"))
	if err != nil {
		t.Fatal(err)
	}
	fixture.collector = files.NewDeliverableCollector(fixture.attachments, nil)
	if err := os.Mkdir(fixture.output, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err = fixture.store.Add(t.Context(), &contracts.ChatMessage{
		ID: "assistant", Role: contracts.RoleAssistant, Text: text, Read: true,
		ReadAt: contracts.Some(7.0), VisibleAttachmentIDs: []string{"already-visible"},
		Source: contracts.RawObject{"origin": json.RawMessage(`"call"`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (fixture *recoveryFixture) recovery(t *testing.T) *files.Recovery {
	t.Helper()
	result, err := files.NewRecovery(files.RecoveryOptions{
		Store: fixture.store, Collector: fixture.collector,
		OutputDirectory: func() string { return fixture.output },
		OnChange:        func() { fixture.changed.Add(1) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func recoveryBody(conversation, href string) contracts.RawObject {
	conversationRaw, _ := json.Marshal(conversation)
	hrefRaw, _ := json.Marshal(href)
	return contracts.RawObject{"conversationId": conversationRaw, "href": hrefRaw}
}

func recoveryStatus(t *testing.T, err error, expected int) {
	t.Helper()
	var public *contracts.APIError
	if !errors.As(err, &public) || public.Status != expected {
		t.Fatalf("public status = %v, want %d", err, expected)
	}
}

func TestRecoveryExplicitImmutableConcurrentSnapshot(t *testing.T) {
	fixture := newRecoveryFixture(t, "[result](output/result.txt)")
	for index := range 620 {
		if err := os.WriteFile(filepath.Join(fixture.output, fmt.Sprintf("unrelated-%03d.txt", index)), []byte("unrelated"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	target := filepath.Join(fixture.output, "result.txt")
	if err := os.WriteFile(target, []byte("original snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	recovery := fixture.recovery(t)
	body := recoveryBody(fixture.store.ConversationID(), "output/result.txt")
	receipts := make([]files.RecoveryReceipt, 12)
	failures := make([]error, len(receipts))
	var group sync.WaitGroup
	for index := range receipts {
		group.Go(func() { receipts[index], failures[index] = recovery.Resolve(t.Context(), "assistant", body) })
	}
	group.Wait()
	for index, receipt := range receipts {
		if failures[index] != nil || receipt.Attachment.ID != receipts[0].Attachment.ID || !receipt.RestoredSnapshot {
			t.Fatalf("concurrent immutable result %d failed: %v", index, failures[index])
		}
	}
	if fixture.changed.Load() != 1 {
		t.Fatal("concurrent resolution changed state more than once")
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	restarted := fixture.recovery(t)
	reused, err := restarted.Resolve(t.Context(), "assistant", body)
	if err != nil || !reused.Reused || reused.Attachment.ID != receipts[0].Attachment.ID {
		t.Fatalf("missing original did not reuse immutable snapshot: %v", err)
	}
	_, data, err := fixture.attachments.Read(t.Context(), reused.Attachment.ID)
	if err != nil || string(data) != "original snapshot" {
		t.Fatal("immutable bytes changed")
	}
	message, err := fixture.store.Message("assistant")
	if err != nil || message.Read || message.ReadAt.Value != 7 || len(message.VisibleAttachmentIDs) != 1 || message.VisibleAttachmentIDs[0] != "already-visible" || string(message.Source["origin"]) != `"call"` {
		t.Fatal("attachment recovery changed existing receipts or source")
	}
}

func TestRecoveryURIOnceAndReferenceLinks(t *testing.T) {
	for _, test := range []struct{ name, source, href string }{
		{"100%20.png", "[file][saved]\n\n[saved]: output/100%2520.png", "output/100%2520.png"},
		{"a b.png", "![file](<output/a b.png>)", "output/a%20b.png"},
		{"截图.png", "[file](output/截图.png)", "output/%E6%88%AA%E5%9B%BE.png"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRecoveryFixture(t, test.source)
			if err := os.WriteFile(filepath.Join(fixture.output, test.name), []byte("fixture"), 0o600); err != nil {
				t.Fatal(err)
			}
			result, err := fixture.recovery(t).Resolve(t.Context(), "assistant", recoveryBody(fixture.store.ConversationID(), test.href))
			if err != nil || result.Attachment.SourcePath != filepath.Join(fixture.output, test.name) {
				t.Fatalf("single URI decode failed: %v", err)
			}
		})
	}
}

func TestRecoveryFailureDoesNotPublishReadOrTaskChanges(t *testing.T) {
	fixture := newRecoveryFixture(t, "[file](output/result.txt)")
	if err := os.WriteFile(filepath.Join(fixture.output, "result.txt"), []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(fixture.store.Snapshot())
	fixture.failWrite.Store(true)
	_, err := fixture.recovery(t).Resolve(t.Context(), "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt"))
	recoveryStatus(t, err, 500)
	after, _ := json.Marshal(fixture.store.Snapshot())
	if !bytes.Equal(before, after) || fixture.changed.Load() != 0 {
		t.Fatal("failed save published partial state")
	}
	fixture.failWrite.Store(false)
	result, err := fixture.recovery(t).Resolve(t.Context(), "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt"))
	if err != nil || result.Reused {
		t.Fatalf("retry after confirmed save failure failed: %v", err)
	}
}

func TestRecoveryRejectsUnavailableAndUnrelatedReferences(t *testing.T) {
	for _, test := range []struct {
		name, source, href, conversation, message string
		status                                    int
	}{
		{"inline code", "`[file](output/result.txt)`", "output/result.txt", "", "assistant", 400},
		{"HTML", `<a href="output/result.txt">file</a>`, "output/result.txt", "", "assistant", 400},
		{"unrelated", "[file](output/other.txt)", "output/result.txt", "", "assistant", 400},
		{"outside", "[file](../result.txt)", "../result.txt", "", "assistant", 404},
		{"secret", "[file](output/access-token.txt)", "output/access-token.txt", "", "assistant", 404},
		{"missing file", "[file](output/missing.txt)", "output/missing.txt", "", "assistant", 404},
		{"missing message", "[file](output/result.txt)", "output/result.txt", "", "missing", 404},
		{"changed conversation", "[file](output/result.txt)", "output/result.txt", "different", "assistant", 409},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRecoveryFixture(t, test.source)
			conversation := test.conversation
			if conversation == "" {
				conversation = fixture.store.ConversationID()
			}
			_, err := fixture.recovery(t).Resolve(t.Context(), test.message, recoveryBody(conversation, test.href))
			recoveryStatus(t, err, test.status)
			if fixture.changed.Load() != 0 {
				t.Fatal("rejected reference changed state")
			}
		})
	}
}

func TestRecoveryRejectsCapHardLinksAndCancelledAdmission(t *testing.T) {
	fixture := newRecoveryFixture(t, "[file](output/result.txt)")
	if err := os.WriteFile(filepath.Join(fixture.output, "source.txt"), []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(fixture.output, "source.txt"), filepath.Join(fixture.output, "result.txt")); err != nil {
		t.Fatal(err)
	}
	body := recoveryBody(fixture.store.ConversationID(), "output/result.txt")
	recovery := fixture.recovery(t)
	_, err := recovery.Resolve(t.Context(), "assistant", body)
	recoveryStatus(t, err, 404)
	if err := fixture.store.Mutate(t.Context(), func(state *contracts.State) error {
		for range files.MaxMessageAttachments {
			state.Messages[0].Attachments = append(state.Messages[0].Attachments, contracts.Attachment{ID: "fixture-existing"})
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	_, err = recovery.Resolve(t.Context(), "assistant", body)
	recoveryStatus(t, err, 409)

	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = recovery.Resolve(cancelled, "assistant", body)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled admission did not stop: %v", err)
	}
}

type recoveryRacingStore struct {
	*store.Store
	beforeCommit func(context.Context) error
}

func (value recoveryRacingStore) Mutate(ctx context.Context, change func(*contracts.State) error) error {
	if err := value.beforeCommit(ctx); err != nil {
		return err
	}
	return value.Store.Mutate(ctx, change)
}

func TestRecoveryRechecksMessageIdentityAtDurableCommit(t *testing.T) {
	fixture := newRecoveryFixture(t, "[file](output/result.txt)")
	if err := os.WriteFile(filepath.Join(fixture.output, "result.txt"), []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	racing := recoveryRacingStore{Store: fixture.store, beforeCommit: func(ctx context.Context) error {
		return fixture.store.Mutate(ctx, func(state *contracts.State) error {
			state.Messages[0].Text = "Changed assistant output"
			return nil
		})
	}}
	admitted := false
	recovery, err := files.NewRecovery(files.RecoveryOptions{
		Store: racing, Collector: fixture.collector,
		OutputDirectory: func() string {
			if admitted {
				t.Fatal("output callback invoked from inside Engine admission")
			}
			return fixture.output
		},
		ConversationTransaction: func(ctx context.Context, conversation string, operation func(context.Context) error) error {
			if conversation != fixture.store.ConversationID() {
				t.Fatal("admitted a different conversation")
			}
			admitted = true
			defer func() { admitted = false }()
			return operation(ctx)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = recovery.Resolve(t.Context(), "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt"))
	recoveryStatus(t, err, 409)
	message, _ := fixture.store.Message("assistant")
	if len(message.Attachments) != 0 || !message.Read || message.Text != "Changed assistant output" {
		t.Fatal("stale output attached to changed message")
	}
}

func TestRecoveryRejectsInvalidBodyHumanMessageAndDuplicateSnapshots(t *testing.T) {
	fixture := newRecoveryFixture(t, "[file](output/result.txt)")
	recovery := fixture.recovery(t)
	body := recoveryBody(fixture.store.ConversationID(), "output/result.txt")
	body["extra"] = json.RawMessage(`true`)
	_, err := recovery.Resolve(t.Context(), "assistant", body)
	recoveryStatus(t, err, 400)
	delete(body, "extra")
	delete(body, "conversationId")
	_, err = recovery.Resolve(t.Context(), "assistant", body)
	recoveryStatus(t, err, 409)
	if _, err := fixture.store.Add(t.Context(), &contracts.ChatMessage{ID: "human", Role: contracts.RoleUser, Text: "[file](output/result.txt)"}); err != nil {
		t.Fatal(err)
	}
	body = recoveryBody(fixture.store.ConversationID(), "output/result.txt")
	_, err = recovery.Resolve(t.Context(), "human", body)
	recoveryStatus(t, err, 404)

	if err := fixture.store.Mutate(t.Context(), func(state *contracts.State) error {
		item := contracts.Attachment{ID: "duplicate", SourcePath: filepath.Join(fixture.output, "result.txt")}
		state.Messages[0].Attachments = []contracts.Attachment{item, item}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	_, err = recovery.Resolve(t.Context(), "assistant", body)
	recoveryStatus(t, err, 404)
}
