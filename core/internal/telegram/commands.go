package telegram

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func (gateway *Gateway) command(ctx context.Context, command string, id int64, args string, owner Owner, bot Bot) error {
	text := ""
	work := gateway.options.WorkSnapshot()
	switch command {
	case "stop":
		stopped := false
		var err error
		if gateway.options.StopOwned != nil {
			stopped, err = gateway.options.StopOwned(ctx, owner, bot)
		}
		if err != nil {
			return err
		}
		text = gateway.word("stopNone")
		if stopped {
			text = gateway.word("stopSuccess")
		}
	case "progress", "porgress":
		text = gateway.ProgressText(false)
	case "status":
		text = gateway.ProgressText(true)
	case "pause":
		if args != "" {
			text = gateway.word("pauseUsage")
		} else if work.Active == nil && !work.Pending && len(work.Queue) == 0 {
			text = gateway.word("pauseNone")
		} else if gateway.options.Pause == nil || gateway.options.Pause(ctx) != nil {
			text = gateway.word("pauseUnconfirmed")
		} else {
			text = gateway.word("pauseSuccess")
		}
	case "resume":
		text = gateway.resume(ctx, work, args)
	default:
		text = gateway.word("help")
	}
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	if gateway.config.Owner == nil || *gateway.config.Owner != owner || gateway.config.Bot == nil || *gateway.config.Bot != bot {
		return ErrIncoming
	}
	_, err := gateway.queueTextLocked(ctx, fmt.Sprintf("command:%d", id), text, OutboxItem{})
	return err
}

func (gateway *Gateway) resume(ctx context.Context, work WorkState, args string) string {
	if !work.Online {
		return gateway.word("connectFirst")
	}
	if work.Takeover || work.Acquiring {
		return gateway.word("returnControl")
	}
	if work.Call != nil && work.Call.Provider == "subscription" {
		return gateway.word("endSubscription")
	}
	if work.Active != nil || work.Pending {
		return gateway.word("activeUnconfirmed")
	}
	state := gateway.options.Store.Snapshot()
	paused := []*contracts.ChatMessage{}
	var selected *contracts.ChatMessage
	for _, message := range state.Messages {
		if message == nil || message.Role != contracts.RoleUser || message.Kind == "call" {
			continue
		}
		status := statusOf(message)
		if status == contracts.MessageStatus(contracts.TaskStatusPaused) {
			paused = append(paused, message)
		}
		if args == message.ID && (status == contracts.MessageStatus(contracts.TaskStatusPaused) || status == contracts.MessageStatus(contracts.TaskStatusFailed) || status == contracts.MessageStatus(contracts.TaskStatusUnknown)) {
			selected = message
		}
	}
	if args == "" && len(paused) == 1 {
		selected = paused[0]
	}
	if selected == nil {
		if args != "" {
			return gateway.word("resumeNotFound")
		}
		if len(paused) == 0 {
			return gateway.word("resumeNone")
		}
		lines := []string{gateway.word("resumeChoose")}
		for _, message := range paused {
			lines = append(lines, "/resume "+message.ID+" · "+gateway.publicText(message.Text))
		}
		return strings.Join(lines, "\n")
	}
	submission, _ := selected.Submission.Get()
	if statusOf(selected) == contracts.MessageStatus(contracts.TaskStatusUnknown) || submission == contracts.SubmissionStatusUnknown || submission == contracts.SubmissionStatusSubmitting || selected.UnknownOutcome {
		return gateway.word("resumeUnknown")
	}
	if gateway.options.Resume == nil || gateway.options.Resume(ctx, []string{selected.ID}) != nil {
		return gateway.word("resumeFailed")
	}
	return gateway.word("resumeSuccess") + "\n" + selected.ID + "\n" + gateway.word("resumeProgress")
}

type recentWork struct {
	title, status, taskID string
	at                    float64
	voice                 bool
}

func (gateway *Gateway) ProgressText(brief bool) string {
	state := gateway.options.Store.Snapshot()
	work := gateway.options.WorkSnapshot()
	computer := gateway.word("offline")
	if work.Online {
		computer = gateway.word("online")
	}
	call := gateway.word("noCall")
	if work.Call != nil {
		call = gateway.word("inCall")
	}
	lines := []string{gateway.word("progress"), gateway.word("computer") + ": " + computer}
	if work.Takeover || work.Acquiring {
		lines = append(lines, gateway.word("control")+": "+gateway.word("human"))
	}
	lines = append(lines, gateway.word("call")+": "+call)
	if work.Pending {
		lines = append(lines, gateway.word("delivery")+": "+gateway.word("awaitingConfirmation"))
	}
	activeIDs := map[string]bool{}
	activeTurn := ""
	if active := work.Active; active != nil {
		activeTurn, _ = active.TurnID.Get()
		id, _ := active.MessageID.Get()
		if id != "" {
			activeIDs[id] = true
		}
		for _, id := range active.MessageIDs {
			if id != "" {
				activeIDs[id] = true
			}
		}
		title := active.Title
		if title == "" {
			if message := messageByID(state, id); message != nil {
				title = message.Text
			}
		}
		if title == "" {
			title = gateway.word("task")
			if active.Source == "voice" {
				title = gateway.word("voiceTask")
			}
		}
		status := string(active.Status)
		if !work.Online {
			status = string(contracts.TaskStatusUnknown)
		}
		label := gateway.stateLabel(status)
		if active.Background {
			label += " · " + gateway.word("background")
		}
		lines = append(lines, gateway.word("current")+": "+gateway.publicText(title), gateway.word("state")+": "+label)
		if started, ok := active.StartedAt.Get(); ok && started > 0 {
			seconds := max(int64(0), (gateway.options.Now().UnixMilli()-int64(started))/1000)
			lines = append(lines, fmt.Sprintf("%s: %d:%02d", gateway.word("elapsed"), seconds/60, seconds%60))
		}
		if updated, ok := active.UpdatedAt.Get(); ok && updated > 0 {
			lines = append(lines, gateway.word("lastUpdate")+": "+time.UnixMilli(int64(updated)).UTC().Format("2006-01-02T15:04:05.000Z"))
		}
		if !brief && active.Plan != nil && len(active.Plan.Steps) > 0 && len(active.Plan.Steps) <= 128 {
			lines = append(lines, gateway.word("taskSteps")+":")
			for index, step := range active.Plan.Steps {
				mark := "○"
				if step.Status == contracts.PlanStepStatusCompleted {
					mark = "✓"
				} else if step.Status == contracts.PlanStepStatusInProgress {
					mark = "◉"
				}
				lines = append(lines, fmt.Sprintf("%d. %s %s", index+1, mark, gateway.publicText(step.Step)))
			}
		}
	}
	turns, registered := map[string]bool{}, map[string]bool{}
	recent := []recentWork{}
	records := append([]contracts.WorkRecord{}, state.WorkTasks...)
	sort.SliceStable(records, func(a, b int) bool { return records[a].UpdatedAt > records[b].UpdatedAt })
	for _, record := range records {
		if record.ID == "" || record.TurnID == "" || turns[record.TurnID] {
			continue
		}
		turns[record.TurnID] = true
		for _, id := range record.TurnIDs {
			if id != "" {
				turns[id] = true
			}
		}
		messageID, _ := record.MessageID.Get()
		message := messageByID(state, messageID)
		if message != nil {
			registered[message.ID] = true
		}
		dismissed, _ := record.ProgressDismissedAt.Get()
		if dismissed > 0 || record.TurnID == activeTurn || work.Active != nil && record.ID == work.Active.WorkID || activeIDs[messageID] || slices.Contains(work.Queue, messageID) {
			continue
		}
		title := record.Title
		if title == "" && message != nil {
			title = message.Text
		}
		if title == "" {
			title = gateway.word("voiceTask")
		}
		if message == nil || message.Role != contracts.RoleUser {
			messageID = ""
		}
		recent = append(recent, recentWork{gateway.publicText(title), string(record.Status), messageID, max(record.UpdatedAt, record.StartedAt), record.Source == "voice"})
	}
	for _, message := range state.Messages {
		if message == nil || message.Role != contracts.RoleUser || message.Kind == "call" || message.WorkKind == "conversation" || message.VoiceCallID != "" && !message.TurnID.Present {
			continue
		}
		turn, _ := message.TurnID.Get()
		dismissed, _ := message.ProgressDismissedAt.Get()
		if activeIDs[message.ID] || slices.Contains(work.Queue, message.ID) || registered[message.ID] || turn != "" && (turns[turn] || turn == activeTurn) || dismissed > 0 {
			continue
		}
		at, _ := message.Time.Get()
		status := string(statusOf(message))
		if status == "read" {
			status = string(contracts.TaskStatusReview)
		}
		recent = append(recent, recentWork{gateway.publicText(message.Text), status, message.ID, at, false})
	}
	sort.SliceStable(recent, func(a, b int) bool { return recent[a].at > recent[b].at })
	ongoing := []recentWork{}
	finished := []recentWork{}
	for _, item := range recent {
		if item.status == string(contracts.WorkStatusContinuing) || item.status == string(contracts.WorkStatusWaitingUser) {
			ongoing = append(ongoing, item)
		} else {
			finished = append(finished, item)
		}
	}
	if work.Active == nil && len(ongoing) == 0 {
		key := "unavailable"
		if work.Online {
			key = "noRunning"
		}
		lines = append(lines, gateway.word(key))
	}
	if len(ongoing) > 0 {
		lines = append(lines, gateway.word("ongoing")+":")
		for _, item := range ongoing {
			status := item.status
			if !work.Online {
				status = string(contracts.TaskStatusUnknown)
			}
			lines = append(lines, "• "+item.title+" — "+gateway.stateLabel(status))
		}
	}
	lines = append(lines, fmt.Sprintf("%s: %d", gateway.word("queued"), len(work.Queue)))
	if !brief {
		for _, id := range work.Queue {
			if message := messageByID(state, id); message != nil {
				lines = append(lines, "• "+gateway.publicText(message.Text))
			}
		}
	}
	if !brief && len(finished) > 0 {
		lines = append(lines, gateway.word("recent")+":")
		for _, item := range finished[:min(len(finished), 5)] {
			status := item.status
			if !work.Online && (status == string(contracts.TaskStatusRunning) || status == string(contracts.TaskStatusWaitingUser) || status == string(contracts.TaskStatusPausing)) {
				status = string(contracts.TaskStatusUnknown)
			}
			lines = append(lines, "• "+item.title+" — "+gateway.stateLabel(status))
			if item.taskID != "" && (item.status == string(contracts.TaskStatusPaused) || item.status == string(contracts.TaskStatusFailed)) {
				lines = append(lines, "/resume "+item.taskID)
			} else if item.voice && item.status == string(contracts.TaskStatusPaused) {
				lines = append(lines, gateway.word("voiceFollowup"))
			}
		}
	}
	return strings.Join(lines, "\n")
}
