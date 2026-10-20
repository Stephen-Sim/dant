package backups

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/schedules"
	"github.com/Stephen-Sim/dant/core/internal/skills"
)

func TestWorkerBackupRestoresIntoDifferentHomeWithCurrentAttachmentsSkillsMemoryAndHeldSchedules(t *testing.T) {
	ctx := t.Context()
	root := t.TempDir()
	oldHome := filepath.Join(root, "old-user", "home")
	oldData := filepath.Join(oldHome, "dant", "data")
	oldWorkspace := filepath.Join(oldHome, "dant", "workspaces")
	for _, directory := range []string{oldData, oldWorkspace} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}

	attachments, err := files.OpenAttachmentStore(filepath.Join(oldData, "attachments"))
	if err != nil {
		t.Fatal(err)
	}
	content := []byte{0, 255, 128, 17, 0, 42}
	attachment, err := attachments.Put(ctx, "saved 数据.bin", "application/octet-stream", content)
	if err != nil {
		t.Fatal(err)
	}
	state := contracts.RawObject{
		"conversationId": json.RawMessage(`"` + testRestoreID + `"`),
		"settings":       json.RawMessage(`{}`),
		"threadId":       json.RawMessage(`"old-thread"`),
		"threadRuntime":  json.RawMessage(`"vm:old-user"`),
		"workTasks":      json.RawMessage(`[]`),
		"completions":    json.RawMessage(`[]`),
	}
	state["messages"], err = json.Marshal([]contracts.RawObject{
		{
			"id":          json.RawMessage(`"unfinished"`),
			"role":        json.RawMessage(`"user"`),
			"text":        json.RawMessage(`"Keep the saved attachment"`),
			"time":        json.RawMessage(`17`),
			"status":      json.RawMessage(`"running"`),
			"attachments": crossRootJSON(t, []contracts.Attachment{attachment}),
		},
		{
			"id":         json.RawMessage(`"uncertain"`),
			"role":       json.RawMessage(`"user"`),
			"status":     json.RawMessage(`"queued"`),
			"submission": json.RawMessage(`"submitting"`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oldData, "state.json"), crossRootJSON(t, state), 0600); err != nil {
		t.Fatal(err)
	}

	library, err := skills.New(oldWorkspace, skills.Options{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = library.Save(ctx, skills.SaveInput{
		Name:         "portable-skill",
		Description:  "Saved portable skill",
		Instructions: "Read references/guide.txt before using assets/sample.bin.",
		Files:        map[string]string{"references/guide.txt": "Keep this reference 中文"},
		BinaryFiles: map[string]skills.BinaryFile{
			"assets/sample.bin": {
				Encoding:  "base64",
				MediaType: "application/octet-stream",
				Data:      base64.StdEncoding.EncodeToString(content),
			},
		},
	}, true)
	if err != nil {
		t.Fatal(err)
	}

	durable, err := memory.OpenStore(ctx, oldData, memory.StoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = durable.Close() })
	if err := durable.WriteNote(ctx, "identity.md", "Keep this identity 中文"); err != nil {
		t.Fatal(err)
	}
	conversation := testRestoreID
	entry, err := durable.Propose(ctx, memory.Proposal{
		Kind:   "semantic",
		Text:   "The cobalt project prefers TypeScript",
		Source: memory.Source{Kind: "user", ConversationID: &conversation},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := durable.Confirm(ctx, entry.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := durable.Propose(ctx, memory.Proposal{
		Kind:   "semantic",
		Text:   "Unconfirmed amber preference",
		Source: memory.Source{Kind: "inference"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := durable.Close(); err != nil {
		t.Fatal(err)
	}
	claim := crossRootSchedules(t, oldData)

	backup, err := CreateWorkerBackup(ctx, WorkerBackupOptions{
		DataDir:       oldData,
		WorkspaceRoot: oldWorkspace,
		TemporaryRoot: root,
		SourceID:      "cross-vm-home-fixture",
		AppVersion:    "0.4.7-beta.16",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backup.Close() })
	var archive bytes.Buffer
	if err := backup.WriteTo(ctx, &archive); err != nil {
		t.Fatal(err)
	}
	if err := backup.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(oldHome, oldHome+".offline"); err != nil {
		t.Fatal(err)
	}

	newHome := filepath.Join(root, "new-user", "different-home")
	newData := filepath.Join(newHome, "dant", "data")
	newWorkspace := filepath.Join(newHome, "dant", "workspaces")
	if err := os.MkdirAll(filepath.Dir(newData), 0700); err != nil {
		t.Fatal(err)
	}
	receipt, err := RestoreWorkerBackup(ctx, RestoreOptions{
		DataDir:       newData,
		WorkspaceRoot: newWorkspace,
		RestoreID:     testRestoreID,
		AssertOffline: func(context.Context) error {
			return nil
		},
	}, bytes.NewReader(archive.Bytes()))
	if err != nil || !receipt.Restored || receipt.RestoreID != testRestoreID {
		t.Fatalf("cross-home restore was not confirmed: %v", err)
	}

	currentAttachments, err := files.OpenAttachmentStore(filepath.Join(newData, "attachments"))
	if err != nil {
		t.Fatal(err)
	}
	current, actual, err := currentAttachments.Read(ctx, attachment.ID)
	if err != nil || !bytes.Equal(actual, content) || current.Name != attachment.Name ||
		current.GuestPath != filepath.Join(newData, "attachments", attachment.ID+".bin") || strings.Contains(current.GuestPath, oldHome) {
		t.Fatalf("restored attachment did not resolve under the new home: %v", err)
	}
	if _, err := os.Lstat(attachment.GuestPath); !os.IsNotExist(err) {
		t.Fatal("fixture old-home attachment unexpectedly remained accessible")
	}
	paused, err := files.ReadRegular(filepath.Join(newData, "state.json"), restoreJSONMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	var restored contracts.State
	if json.Unmarshal(paused, &restored) != nil || restored.ConversationID != conversation ||
		!restored.ThreadID.Null || !restored.ThreadRuntime.Null || len(restored.Messages) != 2 ||
		restored.Messages[0].Status.Value != contracts.MessageStatus(contracts.TaskStatusPaused) ||
		restored.Messages[0].Time.Value != 17 || len(restored.Messages[0].Attachments) != 1 ||
		restored.Messages[0].Attachments[0].ID != attachment.ID ||
		restored.Messages[1].Status.Value != contracts.MessageStatus(contracts.TaskStatusUnknown) ||
		restored.Messages[1].Submission.Value != contracts.SubmissionStatusUnknown || !restored.Messages[1].UnknownOutcome {
		t.Fatal("cross-home restore changed saved identities or relaxed paused/unknown execution fences")
	}

	currentLibrary, err := skills.New(newWorkspace, skills.Options{})
	if err != nil {
		t.Fatal(err)
	}
	skill, err := currentLibrary.ExportSnapshot(ctx, "portable-skill")
	if err != nil || !strings.HasPrefix(skill.Path, newWorkspace+string(filepath.Separator)) ||
		skill.Files["references/guide.txt"] != "Keep this reference 中文" ||
		skill.BinaryFiles["assets/sample.bin"].Data != base64.StdEncoding.EncodeToString(content) {
		t.Fatalf("skill did not retain relative files and use the new workspace: %v", err)
	}
	crossRootMemory(t, newData, conversation, entry.ID)
	crossRootHeldSchedules(t, newData, claim)
}

func crossRootJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func crossRootMemory(t *testing.T, dataDir, conversation, entryID string) {
	t.Helper()
	ctx := t.Context()
	durable, err := memory.OpenStore(ctx, dataDir, memory.StoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer durable.Close()
	if durable.DatabaseFile() != filepath.Join(dataDir, "memory", "dant", "memory.sqlite") {
		t.Fatal("memory database retained the source home")
	}
	identity, err := durable.ReadNote(ctx, "identity.md")
	if err != nil || identity != "Keep this identity 中文" {
		t.Fatal("restored identity note changed", err)
	}
	refs, err := durable.Retrieve(ctx, "cobalt", memory.Scope{ConversationID: conversation}, memory.RetrieveOptions{Limit: 4})
	if err != nil || len(refs) != 1 || refs[0].ID != entryID || refs[0].Source == nil ||
		refs[0].Source.ConversationID == nil || *refs[0].Source.ConversationID != conversation {
		t.Fatalf("restored FTS lost confirmed memory identity or scope: %v", err)
	}
	refs, err = durable.Retrieve(ctx, "amber", memory.Scope{ConversationID: conversation}, memory.RetrieveOptions{Limit: 4})
	if err != nil || len(refs) != 0 {
		t.Fatal("restore promoted candidate memory into confirmed recall", err)
	}
}

func crossRootSchedules(t *testing.T, dataDir string) schedules.Claim {
	t.Helper()
	ctx := t.Context()
	enabled := true
	first := schedules.Record{ID: "claimed-job", Text: "Keep accepted work", At: 1000, Status: contracts.ScheduleStatusPending, Enabled: &enabled}
	second := schedules.Record{ID: "future-job", Text: "Do not dispatch automatically", At: 2000, Status: contracts.ScheduleStatusPending, Enabled: &enabled}
	db, err := schedules.OpenDatabase(ctx, dataDir, []json.RawMessage{crossRootJSON(t, first), crossRootJSON(t, second)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	snapshot, err := db.Snapshot(ctx)
	if err != nil || len(snapshot.Items) != 2 {
		t.Fatal("source schedule snapshot unavailable", err)
	}
	first = snapshot.Items[0]
	messageID := "prepared-occurrence"
	claimed := first
	claimed.Status = contracts.ScheduleStatusDispatched
	claimed.MessageID = &messageID
	claimed.LastRunAt = &first.At
	claim := schedules.Claim{
		Revision:  snapshot.Revision,
		Candidate: first,
		Claimed:   claimed,
		Owner:     "old-vm-runtime",
		Message: schedules.ScheduledMessage{
			ID:               messageID,
			Role:             contracts.RoleUser,
			Text:             first.Text,
			Status:           contracts.TaskStatusQueued,
			Scheduled:        true,
			ScheduleID:       first.ID,
			ScheduledAt:      int64(first.At),
			ProgressPriority: contracts.TaskPriorityNormal,
		},
	}
	if ok, err := db.Claim(ctx, claim); err != nil || !ok {
		t.Fatalf("source schedule claim unavailable: %v", err)
	}
	return claim
}

func crossRootHeldSchedules(t *testing.T, dataDir string, claim schedules.Claim) {
	t.Helper()
	ctx := t.Context()
	db, err := schedules.OpenDatabase(ctx, dataDir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if db.File() != filepath.Join(dataDir, "schedules", "schedules.sqlite") {
		t.Fatal("schedule database retained the source home")
	}
	snapshot, err := db.Snapshot(ctx)
	if err != nil || len(snapshot.Items) != 2 {
		t.Fatal("restored schedule records missing", err)
	}
	for _, item := range snapshot.Items {
		if item.Enabled == nil || *item.Enabled ||
			item.ID == claim.Candidate.ID && item.Status != contracts.ScheduleStatusDispatched ||
			item.ID != claim.Candidate.ID && item.Status != contracts.ScheduleStatusPaused {
			t.Fatal("restored schedule became enabled or lost its accepted occurrence")
		}
	}
	held, err := db.RecoverPrepared(ctx, "new-vm-runtime", false)
	if err != nil || len(held) != 1 || held[0].Message.ID != claim.Message.ID || held[0].Phase != contracts.ScheduleDispatchPhaseHeld {
		t.Fatalf("restored in-flight occurrence did not retain its held identity: %v", err)
	}
	if ok, err := db.FenceHandoff(ctx, claim.Message.ID, claim.Owner); err != nil || ok {
		t.Fatal("source VM owner could hand off the restored held occurrence", err)
	}
}
