package telegram

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func behaviorUpdate(t *testing.T, id int64, text string) Update {
	t.Helper()
	data := raw(map[string]any{
		"update_id": id,
		"message": map[string]any{
			"message_id": id,
			"text":       text,
			"chat":       map[string]any{"id": 21, "type": "private"},
			"from":       map[string]any{"id": 31},
		},
	})
	update, err := ReadUpdate(data)
	if err != nil {
		t.Fatal("isolated update contract", err)
	}
	return update
}

func commandResponse(t *testing.T, fixture *gatewayFixture, id int64, text string) string {
	t.Helper()
	if err := fixture.Gateway.Receive(t.Context(), behaviorUpdate(t, id, text)); err != nil {
		t.Fatal(err)
	}
	fixture.Gateway.mu.Lock()
	defer fixture.Gateway.mu.Unlock()
	if len(fixture.Gateway.config.Outbox) == 0 {
		t.Fatal("owner command produced no durable acknowledgement")
	}
	return fixture.Gateway.config.Outbox[len(fixture.Gateway.config.Outbox)-1].Text
}

func TestOwnerCommandsAcknowledgeOnlyConfirmedControlWithoutAdmittingWork(t *testing.T) {
	for _, scenario := range []string{"help", "progress", "porgress", "status", "stop-none", "stop-confirmed", "stop-failed", "pause-args", "pause-idle", "pause-missing", "pause-failed", "pause-confirmed"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			work := WorkState{Online: true}
			fixture.Gateway.options.WorkSnapshot = func() WorkState { return work }
			controlCalls := 0
			command := "/" + scenario
			want := "help"

			switch scenario {
			case "progress", "porgress", "status":
				want = "progress"
			case "stop-none", "stop-confirmed", "stop-failed":
				command, want = "/stop", "stopNone"
				fixture.Gateway.options.StopOwned = func(_ context.Context, owner Owner, bot Bot) (bool, error) {
					controlCalls++
					if owner.PairingID != "fixture-pairing" || bot.ID != "11" {
						t.Error("control did not retain the captured pairing and bot")
					}
					if scenario == "stop-failed" {
						return false, errors.New("isolated control failure")
					}
					return scenario == "stop-confirmed", nil
				}
				if scenario == "stop-confirmed" {
					want = "stopSuccess"
				}
			case "pause-args":
				command, want = "/pause extra", "pauseUsage"
			case "pause-idle":
				command, want = "/pause", "pauseNone"
			case "pause-missing", "pause-failed", "pause-confirmed":
				command, want, work.Pending = "/pause", "pauseUnconfirmed", true
				if scenario != "pause-missing" {
					fixture.Gateway.options.Pause = func(context.Context) error {
						controlCalls++
						if scenario == "pause-failed" {
							return errors.New("isolated pause unconfirmed")
						}
						return nil
					}
				}
				if scenario == "pause-confirmed" {
					want = "pauseSuccess"
				}
			}

			if scenario == "stop-failed" {
				if err := fixture.Gateway.Receive(t.Context(), behaviorUpdate(t, 100, command)); err != nil {
					t.Fatal(err)
				}
				fixture.Gateway.mu.Lock()
				receipt := fixture.Gateway.config.Receipts[0]
				fixture.Gateway.mu.Unlock()
				if receipt.Status != ReceiptFailed || controlCalls != 1 {
					t.Fatal("unconfirmed stop was presented as confirmed")
				}
			} else if response := commandResponse(t, fixture, 100, command); !strings.Contains(response, fixture.Gateway.word(want)) {
				t.Fatal("command acknowledgement did not match the actual control outcome")
			}
			if err := fixture.Gateway.Receive(t.Context(), behaviorUpdate(t, 100, command)); err != nil {
				t.Fatal(err)
			}
			if controlCalls > 1 || fixture.Admitted.Load() != 0 {
				t.Fatal("command replayed control or started a task")
			}
		})
	}
}

func TestResumeUsesOneExactEligibleTaskAndPreservesEveryOwnershipFence(t *testing.T) {
	for _, scenario := range []string{"offline", "human", "acquiring", "subscription", "active", "pending", "none", "choose", "not-found", "unknown", "submitting", "unknown-outcome", "failed-needs-id", "resume-missing", "resume-error", "resume-confirmed"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			work := WorkState{Online: true}
			fixture.Gateway.options.WorkSnapshot = func() WorkState { return work }
			var message *contracts.ChatMessage
			if scenario != "none" {
				message = fixture.add(t, contracts.RoleUser, "isolated paused request")
				_, err := fixture.Store.Update(t.Context(), message.ID, contracts.MessagePatch{"status": raw(contracts.TaskStatusPaused)})
				if err != nil {
					t.Fatal(err)
				}
			}
			command, want := "/resume", "resumeFailed"
			resumed := []string{}
			fixture.Gateway.options.Resume = func(_ context.Context, ids []string) error {
				resumed = append(resumed, ids...)
				if scenario == "resume-error" {
					return errors.New("isolated resume rejection")
				}
				return nil
			}

			switch scenario {
			case "offline":
				work.Online, want = false, "connectFirst"
			case "human":
				work.Takeover, want = true, "returnControl"
			case "acquiring":
				work.Acquiring, want = true, "returnControl"
			case "subscription":
				work.Call, want = &contracts.Call{Provider: "subscription"}, "endSubscription"
			case "active":
				work.Active, want = &contracts.ActiveExecution{}, "activeUnconfirmed"
			case "pending":
				work.Pending, want = true, "activeUnconfirmed"
			case "none":
				want = "resumeNone"
			case "choose":
				other := fixture.add(t, contracts.RoleUser, "other isolated paused request")
				if _, err := fixture.Store.Update(t.Context(), other.ID, contracts.MessagePatch{"status": raw(contracts.TaskStatusPaused)}); err != nil {
					t.Fatal(err)
				}
				want = "resumeChoose"
			case "not-found":
				command, want = "/resume missing", "resumeNotFound"
			case "unknown", "submitting", "unknown-outcome":
				patch := contracts.MessagePatch{}
				if scenario == "unknown" {
					patch["status"] = raw(contracts.TaskStatusUnknown)
					command += " " + message.ID
				} else if scenario == "submitting" {
					patch["submission"] = raw(contracts.SubmissionStatusSubmitting)
				} else {
					patch["unknownOutcome"] = raw(true)
				}
				if _, err := fixture.Store.Update(t.Context(), message.ID, patch); err != nil {
					t.Fatal(err)
				}
				want = "resumeUnknown"
			case "failed-needs-id":
				if _, err := fixture.Store.Update(t.Context(), message.ID, contracts.MessagePatch{"status": raw(contracts.TaskStatusFailed)}); err != nil {
					t.Fatal(err)
				}
				want = "resumeNone"
			case "resume-missing":
				fixture.Gateway.options.Resume = nil
			case "resume-confirmed":
				command += " " + message.ID
				want = "resumeSuccess"
			}

			if response := commandResponse(t, fixture, 100, command); !strings.Contains(response, fixture.Gateway.word(want)) {
				t.Fatal("resume ignored the exact eligibility or ownership guard")
			}
			if scenario == "resume-confirmed" || scenario == "resume-error" {
				if !slices.Equal(resumed, []string{message.ID}) {
					t.Fatal("resume did not target precisely the selected task")
				}
			} else if len(resumed) != 0 {
				t.Fatal("blocked resume invoked execution")
			}
			if fixture.Admitted.Load() != 0 {
				t.Fatal("resume generated an unrelated task")
			}
		})
	}
}

func TestProgressProjectsCurrentQueuePlansAndRecentWorkWithoutPrivateInternals(t *testing.T) {
	fixture := fixture(t)
	active := fixture.add(t, contracts.RoleUser, "active request")
	queued := fixture.add(t, contracts.RoleUser, "queued request")
	recent := fixture.add(t, contracts.RoleUser, "recent request")
	if _, err := fixture.Store.Update(t.Context(), recent.ID, contracts.MessagePatch{"status": raw(contracts.TaskStatusPaused)}); err != nil {
		t.Fatal(err)
	}
	work := WorkState{
		Online: true, Takeover: true, Pending: true,
		Call: &contracts.Call{Provider: "api"}, Queue: []string{queued.ID, "missing"},
		Active: &contracts.ActiveExecution{
			MessageID: contracts.Some(active.ID), MessageIDs: []string{active.ID},
			TurnID: contracts.Some("isolated-active-turn"), Status: contracts.TaskStatusWaitingUser,
			StartedAt: contracts.Some(float64(1000)), UpdatedAt: contracts.Some(float64(2000)),
			Background: true,
			Plan: &contracts.TaskPlan{Steps: []contracts.PlanStep{
				{Step: "verified step", Status: contracts.PlanStepStatusCompleted},
				{Step: "current step", Status: contracts.PlanStepStatusInProgress},
				{Step: "pending step", Status: contracts.PlanStepStatusPending},
			}},
		},
	}
	fixture.Gateway.options.WorkSnapshot = func() WorkState { return work }
	if err := fixture.Store.Mutate(t.Context(), func(state *contracts.State) error {
		state.WorkTasks = []contracts.WorkRecord{
			{ID: "isolated-ongoing", TurnID: "continuing-turn", Title: "ongoing request", Status: contracts.WorkStatusContinuing, UpdatedAt: 5000},
			{ID: "isolated-voice", TurnID: "voice-turn", Source: "voice", Status: contracts.WorkStatusPaused, UpdatedAt: 4000},
			{ID: "isolated-dismissed", TurnID: "dismissed-turn", Title: "dismissed request", Status: contracts.WorkStatusFailed, ProgressDismissedAt: contracts.Some(float64(10))},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	text := fixture.Gateway.ProgressText(false)
	for _, visible := range []string{"active request", "queued request", "recent request", "ongoing request", "verified step", "current step", "pending step", "0:19", "1970-01-01T00:00:02.000Z", "/resume " + recent.ID, fixture.Gateway.word("voiceFollowup")} {
		if !strings.Contains(text, visible) {
			t.Fatal("progress lost public task state")
		}
	}
	if strings.Contains(text, "dismissed request") || strings.Contains(fixture.Gateway.ProgressText(true), "verified step") {
		t.Fatal("progress exposed dismissed work or ignored brief mode")
	}
	work.Online = false
	if text := fixture.Gateway.ProgressText(false); !strings.Contains(text, fixture.Gateway.stateLabel("unknown")) {
		t.Fatal("offline projection implied running execution")
	}
	work.Active = nil
	if text := fixture.Gateway.ProgressText(true); strings.Contains(text, "active request") {
		t.Fatal("retired current ownership remained active")
	}
}

func TestProgressKeepsVoiceFallbacksAndOneCanonicalRecordAcrossLegacyTurnAliases(t *testing.T) {
	fixture := fixture(t)
	linked := fixture.add(t, contracts.RoleUser, "linked durable request")
	legacy := fixture.add(t, contracts.RoleUser, "legacy turn should not repeat")
	read := fixture.add(t, contracts.RoleUser, "review request")
	conversation := fixture.add(t, contracts.RoleUser, "ordinary conversation must stay out of work")
	for id, patch := range map[string]contracts.MessagePatch{
		legacy.ID:       {"turnId": raw("legacy-alias")},
		read.ID:         {"status": raw(contracts.MessageStatusRead)},
		conversation.ID: {"workKind": raw("conversation")},
	} {
		if _, err := fixture.Store.Update(t.Context(), id, patch); err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.Store.Mutate(t.Context(), func(state *contracts.State) error {
		state.WorkTasks = []contracts.WorkRecord{
			{ID: "canonical", TurnID: "latest-turn", TurnIDs: []string{"legacy-alias"}, MessageID: contracts.Some(linked.ID), Status: contracts.WorkStatusWaitingUser, UpdatedAt: 30},
			{ID: "duplicate", TurnID: "legacy-alias", Title: "duplicate old work", Status: contracts.WorkStatusPaused, UpdatedAt: 20},
			{ID: "voice-without-message", TurnID: "voice-turn", Source: "voice", Status: contracts.WorkStatusPaused, UpdatedAt: 10},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	work := WorkState{Online: true, Active: &contracts.ActiveExecution{Source: "voice", Status: contracts.TaskStatusRunning}}
	fixture.Gateway.options.WorkSnapshot = func() WorkState { return work }
	text := fixture.Gateway.ProgressText(false)
	for _, wanted := range []string{fixture.Gateway.word("voiceTask"), "linked durable request", "review request", fixture.Gateway.word("voiceFollowup")} {
		if !strings.Contains(text, wanted) {
			t.Errorf("progress dropped an isolated public label: %s", wanted)
		}
	}
	for _, hidden := range []string{"duplicate old work", "legacy turn should not repeat", "ordinary conversation must stay out of work"} {
		if strings.Contains(text, hidden) {
			t.Fatal("progress duplicated aliased work or exposed normal conversation as a task")
		}
	}
	work.Active.Source = ""
	if text := fixture.Gateway.ProgressText(true); !strings.Contains(text, fixture.Gateway.word("task")) {
		t.Fatal("anonymous active task lost its fixed fallback label")
	}
}
