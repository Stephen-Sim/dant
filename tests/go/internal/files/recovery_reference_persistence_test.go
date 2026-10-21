package files_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

func TestOutputRecoveryRejectsMissingInvalidAndOverlongReferencesBeforePublication(t *testing.T) {
	fixture := newRecoveryFixture(t, "[result](output/result.txt)")
	for _, href := range []json.RawMessage{nil, json.RawMessage(`false`), json.RawMessage(`""`), json.RawMessage(`"bad\nreference"`), json.RawMessage(`"` + strings.Repeat("a", files.MaxRecoveryHrefUnits+1) + `"`), json.RawMessage(`"\ud800"`)} {
		body := recoveryBody(fixture.store.ConversationID(), "output/result.txt")
		body["href"] = href
		_, err := fixture.recovery(t).Resolve(t.Context(), "assistant", body)
		recoveryStatus(t, err, 400)
	}
	message, err := fixture.store.Message("assistant")
	if err != nil || len(message.Attachments) != 0 || fixture.changed.Load() != 0 {
		t.Fatal("invalid reference published attachment metadata", err)
	}
}

func TestOutputRecoveryCannotCommitWhenItsAttachmentRepositoryBecomesUnavailable(t *testing.T) {
	fixture := newRecoveryFixture(t, "[result](output/result.txt)")
	if err := os.WriteFile(filepath.Join(fixture.output, "result.txt"), []byte("valid authored output"), 0600); err != nil {
		t.Fatal(err)
	}
	root := fixture.attachments.Directory()
	recovery, err := files.NewRecovery(files.RecoveryOptions{
		Store: fixture.store, Collector: fixture.collector,
		OutputDirectory: func() string { return fixture.output },
		ConversationTransaction: func(ctx context.Context, _ string, operation func(context.Context) error) error {
			if err := os.Rename(root, root+"-retained"); err != nil {
				return err
			}
			if err := os.WriteFile(root, []byte("replacement must survive"), 0600); err != nil {
				return err
			}
			return operation(ctx)
		},
		OnChange: func() { fixture.changed.Add(1) },
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = recovery.Resolve(t.Context(), "assistant", recoveryBody(fixture.store.ConversationID(), "output/result.txt"))
	recoveryStatus(t, err, 404)
	message, err := fixture.store.Message("assistant")
	if err != nil || len(message.Attachments) != 0 || fixture.changed.Load() != 0 {
		t.Fatal("unavailable attachment persistence was committed to the conversation", err)
	}
	if raw, err := os.ReadFile(root); err != nil || string(raw) != "replacement must survive" {
		t.Fatal("failed attachment recovery removed an unrelated replacement", err)
	}
	if raw, err := os.ReadFile(filepath.Join(fixture.output, "result.txt")); err != nil || string(raw) != "valid authored output" {
		t.Fatal("failed attachment recovery changed authored output", err)
	}
}
