package schedules

import (
	"fmt"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func schedulePointer[T any](value T) *T { return &value }

func TestScheduledOccurrenceRemainsUnfinishedUntilAllOwnedWorkIsConfirmed(t *testing.T) {
	for _, test := range []struct {
		name       string
		record     Record
		state      contracts.State
		active     []string
		queued     []string
		unfinished bool
	}{
		{"missing dispatched message", Record{ID: "schedule", MessageID: schedulePointer("message")}, contracts.State{}, nil, nil, true},
		{"terminal retained receipt", Record{ID: "schedule", RunHistory: []Receipt{{MessageID: "message", WorkID: schedulePointer("work"), TurnID: schedulePointer("turn"), TerminalStatus: schedulePointer("completed"), TerminalAt: schedulePointer(float64(1000))}}}, contracts.State{}, nil, nil, false},
		{"queued occurrence", Record{ID: "schedule"}, contracts.State{Messages: []*contracts.ChatMessage{{ID: "message", ScheduleID: "schedule", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusQueued))}}}, nil, nil, true},
		{"unconfirmed terminal message", Record{ID: "schedule"}, contracts.State{Messages: []*contracts.ChatMessage{{ID: "message", ScheduleID: "schedule", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted)), UnknownOutcome: true}}}, nil, nil, true},
		{"active execution", Record{ID: "schedule"}, contracts.State{Messages: []*contracts.ChatMessage{{ID: "message", ScheduleID: "schedule", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))}}}, []string{"message"}, nil, true},
		{"queued execution", Record{ID: "schedule"}, contracts.State{Messages: []*contracts.ChatMessage{{ID: "message", ScheduleID: "schedule", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))}}}, []string{"unrelated"}, []string{"message"}, true},
		{"owned work still paused", Record{ID: "schedule"}, contracts.State{Messages: []*contracts.ChatMessage{{ID: "message", ScheduleID: "schedule", WorkID: "work", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))}}, WorkTasks: []contracts.WorkRecord{{ID: "work", Status: contracts.WorkStatusPaused}}}, nil, nil, true},
		{"related turn history unknown", Record{ID: "schedule"}, contracts.State{Messages: []*contracts.ChatMessage{{ID: "message", ScheduleID: "schedule", TurnID: contracts.Some("turn"), Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))}}, WorkTasks: []contracts.WorkRecord{{ID: "work", TurnID: "new-turn", TurnIDs: []string{"turn"}, Status: contracts.WorkStatusCompleted, Submission: contracts.Some(contracts.SubmissionStatusUnknown)}}}, nil, nil, true},
		{"related message completed", Record{ID: "schedule"}, contracts.State{Messages: []*contracts.ChatMessage{{ID: "message", ScheduleID: "schedule", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusCompleted))}}, WorkTasks: []contracts.WorkRecord{{ID: "work", MessageID: contracts.Some("message"), Status: contracts.WorkStatusCompleted}}}, nil, nil, false},
		{"foreign work ignored", Record{ID: "schedule"}, contracts.State{Messages: []*contracts.ChatMessage{nil, {ID: "other", ScheduleID: "foreign", Status: contracts.Some(contracts.MessageStatus(contracts.TaskStatusRunning))}}, WorkTasks: []contracts.WorkRecord{{ID: "other-work", Status: contracts.WorkStatusRunning}}}, nil, nil, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheduler := &Scheduler{options: Options{ActiveIDs: func() []string { return test.active }, QueuedIDs: func() []string { return test.queued }}}
			if scheduler.unfinished(test.record, test.state) != test.unfinished {
				t.Fatal("schedule occurrence lost its outstanding owner or fabricated completion")
			}
		})
	}
	for _, continuation := range []*contracts.WorkContinuation{{Invalid: true}, {Dispatch: &contracts.ContinuationDispatch{}}} {
		if !unresolved(contracts.Optional[contracts.SubmissionStatus]{}, false, continuation) {
			t.Fatal("unconfirmed continuation became eligible for another scheduled occurrence")
		}
	}
	if messageStatus(nil) != "" || terminalReceipt(Receipt{MessageID: "bad id", TerminalStatus: schedulePointer("completed"), TerminalAt: schedulePointer(float64(1000))}) {
		t.Fatal("missing or malformed terminal evidence was accepted")
	}
}

func TestScheduleRunHistoryMergesLatestReceiptAndRetainsBoundedOccurrences(t *testing.T) {
	record := Record{At: 1000, MessageID: schedulePointer("current"), DispatchedAt: schedulePointer(float64(2000)), RunHistory: []Receipt{{MessageID: ""}, {MessageID: "current", At: schedulePointer(float64(1))}, {MessageID: "prior"}, {MessageID: "prior", At: schedulePointer(float64(3))}}}
	result := runHistory(record, &Receipt{TerminalStatus: schedulePointer("completed"), TerminalAt: schedulePointer(float64(3000)), WorkID: schedulePointer("work"), TurnID: schedulePointer("turn")})
	if len(result) != 2 || result[0].MessageID != "current" || *result[0].At != 1000 || *result[0].DispatchedAt != 2000 || *result[0].TerminalAt != 3000 || *result[0].WorkID != "work" || *result[0].TurnID != "turn" || *result[1].At != 3 {
		t.Fatal("run receipt lost its current occurrence metadata", result)
	}
	record.LastRunAt = schedulePointer(float64(1500))
	result = runHistory(record, nil)
	if *result[0].At != 1500 {
		t.Fatal("latest run time was not retained")
	}
	record.RunHistory = nil
	for index := range RunHistoryLimit + 2 {
		record.RunHistory = append(record.RunHistory, Receipt{MessageID: fmt.Sprintf("message-%d", index)})
	}
	record.MessageID = schedulePointer("new-message")
	result = runHistory(record, nil)
	if len(result) != RunHistoryLimit || result[0].MessageID != "message-3" || result[len(result)-1].MessageID != "new-message" {
		t.Fatal("run history did not retain the newest bounded occurrences")
	}
}
