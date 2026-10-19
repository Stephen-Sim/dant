package work

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

type outputFixture struct {
	file     contracts.Attachment
	explicit int
}

func (fixture *outputFixture) CaptureBaseline(context.Context, string) (json.RawMessage, error) {
	return json.RawMessage(`{}`), nil
}

func (fixture *outputFixture) Archive(context.Context, string, string, json.RawMessage) ([]contracts.Attachment, error) {
	return []contracts.Attachment{}, nil
}

func (fixture *outputFixture) ArchiveExplicit(_ context.Context, input files.ArchiveInput) ([]contracts.Attachment, error) {
	fixture.explicit++
	if !input.OnlyExplicit || input.IsCurrent == nil || !input.IsCurrent() {
		return nil, ErrStaleOwner
	}
	return []contracts.Attachment{fixture.file}, nil
}

func TestQuietOutputLinkSurvivesACompletedResponseAndAHumanFollowUp(t *testing.T) {
	engine, persistence, worker := engineFixture(t)
	collector := &outputFixture{file: contracts.Attachment{ID: "file-first", Name: "result.bin", Hash: "first", SourcePath: "/output/result.bin"}}
	engine.options.Deliverables = collector
	workID, fromTurn := savedUnfinished(t, persistence)
	continueFixture(t, engine, worker, workID, fromTurn, "quiet-turn")
	owner, ok := engine.ToolScope()
	if !ok {
		t.Fatal("missing admitted owner")
	}
	if _, err := engine.DeliverText(context.Background(), "[result](result.bin)", owner); err != nil {
		t.Fatal(err)
	}
	if collector.explicit != 1 || len(persistence.Snapshot().Messages) != 0 {
		t.Fatal("quiet link was not safely archived without publishing")
	}
	if err := engine.Handle(context.Background(), terminal("quiet-turn", "completed")); err != nil {
		t.Fatal(err)
	}
	if len(persistence.Snapshot().Messages) != 0 || len(engine.quietFiles[workID]) != 1 {
		t.Fatal("unfinished response lost its buffered file or published narration")
	}

	engine.mu.Lock()
	active := &execution{conversationID: persistence.ConversationID(), workID: workID, turnID: "human-followup", humanResponse: true, outputs: map[string]string{}, items: map[string]string{}, epoch: engine.epoch}
	engine.active = active
	engine.mu.Unlock()
	engine.archiveFinalOutputs(active)
	state := persistence.Snapshot()
	if len(state.Messages) != 1 || len(state.Messages[0].Attachments) != 1 || state.Messages[0].Attachments[0].ID != collector.file.ID || len(engine.quietFiles[workID]) != 0 {
		t.Fatal("human follow-up discarded the previous turn's buffered result")
	}
	engine.mu.Lock()
	engine.active = nil
	engine.mu.Unlock()
}

func TestQuietFilesRetainLatestVersionPerOutputPathAndBoundWorkAndFileCounts(t *testing.T) {
	engine, _, _ := engineFixture(t)
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if err := engine.bufferQuietFilesLocked("work", []contracts.Attachment{{ID: "old", SourcePath: "/output/same", Hash: "old"}, {ID: "other", SourcePath: "/output/other", Hash: "other"}, {ID: "new", SourcePath: "/output/same", Hash: "new"}}); err != nil {
		t.Fatal(err)
	}
	files := engine.quietFiles["work"]
	if len(files) != 2 || files[0].ID != "other" || files[1].ID != "new" {
		t.Fatal("updated output path kept stale bytes")
	}
	for index := 0; index < 310; index++ {
		key := string(rune(0x1000 + index))
		if err := engine.bufferQuietFilesLocked(key, []contracts.Attachment{{ID: key}}); err != nil {
			t.Fatal(err)
		}
	}
	if len(engine.quietFiles) > 300 || len(engine.quietFileOrder) > 300 {
		t.Fatal("quiet delivery retention is unbounded")
	}
}
