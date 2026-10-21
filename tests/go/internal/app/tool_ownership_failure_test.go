package app

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	workerRuntime "github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func TestWorkerToolOwnershipIsRecheckedAcrossHumanControlAndReadOnlyCompletion(t *testing.T) {
	app, wire, owner := acknowledgedToolFixture(t)
	before := app.store.Revision()
	wrong := owner
	wrong.TurnID = "replacement-turn"
	wrong.IsCurrent = func() bool { return true }
	if _, err := app.toolOwner(wrong); !errors.Is(err, work.ErrStaleOwner) {
		t.Fatal("caller-supplied current predicate bypassed exact execution identity", err)
	}
	if _, err := app.credentialTool(t.Context(), "credential_request", contracts.RawObject{"name": encode("isolated credential")}, wrong); !errors.Is(err, work.ErrStaleOwner) {
		t.Fatal("retired execution created a credential prompt", err)
	}
	checks := 0
	late := owner
	late.IsCurrent = func() bool {
		checks++
		return checks == 1
	}
	if _, err := app.Execute(t.Context(), "skill_list", contracts.RawObject{}, late); !errors.Is(err, work.ErrStaleOwner) || checks != 2 {
		t.Fatal("read-only tool published a result after its caller retired", err)
	}
	if app.store.Revision() != before {
		t.Fatal("rejected read-only ownership introduced a durable mutation")
	}
	if err := app.engine.BeginComputerAcquire(); err != nil {
		t.Fatal(err)
	}
	defer app.engine.AbortComputerAcquire()
	acquiredRevision := app.store.Revision()
	owner.IsCurrent = func() bool { return true }
	if _, err := app.toolOwner(owner); !errors.Is(err, work.ErrStaleOwner) {
		t.Fatal("human control acquisition allowed an acknowledged tool to continue", err)
	}
	if app.store.Revision() != acquiredRevision || wire.count("turn/start") != 1 {
		t.Fatal("rejected ownership introduced a durable mutation or second execution")
	}
}

func TestWorkerToolPersistenceAndFileFailuresDoNotInventDeliveries(t *testing.T) {
	app, wire, owner := acknowledgedToolFixture(t)
	before := app.store.Revision()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := app.Execute(ctx, "skill_save", contracts.RawObject{
		"name": encode("cancelled-skill"), "description": encode("isolated"), "instructions": encode("Do not execute helpers."),
	}, owner); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled skill persistence was reported saved", err)
	}
	late := owner
	late.IsCurrent = func() bool { return false }
	if _, err := app.fileTool(t.Context(), "send_file", contracts.RawObject{"path": encode("unconfirmed")}, late); !errors.Is(err, work.ErrStaleOwner) {
		t.Fatal("retired tool proceeded to archive a file", err)
	}
	if _, err := app.fileTool(t.Context(), "send_file", contracts.RawObject{"path": encode(filepath.Join(t.TempDir(), "missing.bin"))}, owner); err == nil {
		t.Fatal("missing output was reported as delivered")
	}
	if app.store.Revision() != before || wire.count("turn/start") != 1 {
		t.Fatal("failed skill/file operation introduced a message or second execution")
	}
}

func TestWorkerVoiceFileToolDoesNotRetryAFailedOwnedSpeechHelper(t *testing.T) {
	runs := 0
	app, _ := connectedWorkerFixture(t, func(options *WorkerOptions) {
		options.WorkerOptions.RunVoiceMessage = func(context.Context, workerRuntime.VoiceMessageCommand) ([]byte, error) {
			runs++
			return nil, errors.New("isolated speech helper failed")
		}
	})
	before := app.store.Revision()
	owner := work.ToolContext{ConversationID: app.store.ConversationID(), TurnID: "isolated-turn", IsCurrent: func() bool { return true }}
	if _, err := app.fileTool(t.Context(), "create_voice_message", contracts.RawObject{"text": encode("isolated speech input")}, owner); err == nil || runs != 1 {
		t.Fatal("failed speech helper was retried or reported as a delivered file", err)
	}
	if app.store.Revision() != before {
		t.Fatal("failed voice file introduced a durable delivery")
	}
}
