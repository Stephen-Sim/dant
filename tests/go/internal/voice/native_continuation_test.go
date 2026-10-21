package voice

import (
	"errors"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func continuationFixture(t *testing.T) (*Native, *nativeSession, work.ContinuationOwner) {
	t.Helper()
	native, _, _, persistence := nativeFixture(t)
	owner := work.ContinuationOwner{ConversationID: persistence.ConversationID(), ThreadID: "shared-thread", WorkID: "work-one", AttemptID: "attempt-one", FromTurnID: "old-turn", EngineEpoch: 1}
	session := &nativeSession{mediaID: "media-one", threadID: owner.ThreadID, status: contracts.VoiceCallStatusConnected, connectedAt: 1000, started: true, startAccepted: true, generation: 2, workEpoch: 3, turns: map[string]*nativeTurn{}, callInputs: map[string]*nativeInput{}, finished: map[string]bool{}}
	native.session = session
	return native, session, owner
}

func TestNativeContinuationAdmissionKeepsCallGenerationAndAcknowledgedTurn(t *testing.T) {
	native, session, owner := continuationFixture(t)
	if !native.CanContinueWhileIdle(owner) {
		t.Fatal("idle connected call refused a scoped continuation")
	}
	admission, err := native.BeginContinuationAdmission(owner)
	if err != nil || admission.Owner != owner || admission.CallID != session.mediaID || admission.Generation != session.generation || admission.WorkEpoch != session.workEpoch {
		t.Fatal("continuation admission lost captured call identity", admission, err)
	}
	if _, err := native.BeginContinuationAdmission(owner); !errors.Is(err, ErrNativeUnknown) {
		t.Fatal("a second admission replaced the first", err)
	}
	events := []runtime.Event{
		{Method: "turn/started", Params: object(map[string]any{"threadId": owner.ThreadID, "turnId": "accepted-turn"})},
		{Method: "turn/started", Params: object(map[string]any{"threadId": "other-thread", "turnId": "foreign-turn"})},
	}
	owned, conflict, err := native.ReplayContinuationEvents(t.Context(), admission, events, "accepted-turn", false)
	if err != nil || conflict || len(owned) != 1 || turnID(owned[0]) != "accepted-turn" {
		t.Fatal("replay failed to separate the acknowledged owner", owned, conflict, err)
	}
	if err := native.ConfirmContinuationAdmission(admission, "accepted-turn"); err != nil || !session.continuation.acknowledged {
		t.Fatal("checked acknowledgement was not committed", err)
	}
	stale := admission
	stale.Generation++
	native.FinishContinuationAdmission(stale)
	if session.continuation == nil {
		t.Fatal("stale generation released the current admission")
	}
	native.FinishContinuationAdmission(admission)
	if session.continuation != nil {
		t.Fatal("matching admission was not released")
	}
}

func TestNativeContinuationBlocksBusyUnknownOrChangedOwnership(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*nativeSession)
	}{
		{"unconfirmed media", func(s *nativeSession) { s.startAccepted = false }},
		{"background", func(s *nativeSession) { s.background = true }},
		{"stopping", func(s *nativeSession) { s.stopping = true }},
		{"unknown", func(s *nativeSession) { s.unknown = true }},
		{"queued event", func(s *nativeSession) { s.queuedEvents = 1 }},
		{"active turn", func(s *nativeSession) { s.turns["turn"] = &nativeTurn{} }},
		{"unsettled input", func(s *nativeSession) { s.callInputs["input"] = &nativeInput{} }},
		{"pending handoff", func(s *nativeSession) { s.handoffs = map[string]*nativeHandoff{"handoff": {}} }},
		{"conflicted continuation", func(s *nativeSession) { s.continuation = &nativeContinuation{conflict: true} }},
		{"busy context", func(s *nativeSession) { s.contextQueue = &ContextQueue{pending: []*pendingContext{{}}} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			native, session, owner := continuationFixture(t)
			test.mutate(session)
			if native.CanContinueWhileIdle(owner) {
				t.Fatal("unsafe call admitted another continuation")
			}
			if _, err := native.BeginContinuationAdmission(owner); !errors.Is(err, ErrNativeUnknown) {
				t.Fatal("unsafe admission did not preserve unknown state", err)
			}
		})
	}
	native, session, owner := continuationFixture(t)
	session.turns["finished"] = &nativeTurn{done: true}
	session.callInputs["settled"] = &nativeInput{settled: true}
	session.contextQueue = &ContextQueue{}
	if !native.CanContinueWhileIdle(owner) {
		t.Fatal("settled observations blocked an idle call")
	}
	engine := native.options.Engine.(*nativeFixtureEngine)
	engine.active = &contracts.ActiveExecution{WorkID: "other-work"}
	if native.CanContinueWhileIdle(owner) {
		t.Fatal("another active work owner was ignored")
	}
}

func TestNativeContinuationReplayRetainsUnknownOutcomesWithoutResubmission(t *testing.T) {
	for _, test := range []struct {
		name         string
		ack          string
		notSubmitted bool
		foreign      bool
		stale        bool
		existingTurn bool
	}{
		{"missing acknowledgement", "", false, false, false, false},
		{"foreign concurrent event", "accepted-turn", false, true, false, false},
		{"stale admission", "accepted-turn", false, false, true, false},
		{"already observed turn", "accepted-turn", false, false, false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			native, session, owner := continuationFixture(t)
			admission, err := native.BeginContinuationAdmission(owner)
			if err != nil {
				t.Fatal(err)
			}
			if test.stale {
				session.generation++
			}
			if test.existingTurn {
				session.finished["accepted-turn"] = true
			}
			events := []runtime.Event{{Method: "turn/started", Params: object(map[string]any{"threadId": owner.ThreadID, "turnId": "accepted-turn"})}}
			if test.foreign {
				events = append(events, runtime.Event{Method: "turn/started", Params: object(map[string]any{"threadId": owner.ThreadID, "turnId": "foreign"})})
			}
			_, conflict, err := native.ReplayContinuationEvents(t.Context(), admission, events, test.ack, test.notSubmitted)
			if err != nil || !conflict || !test.stale && !session.unknown {
				t.Fatal("unconfirmed continuation became successful", conflict, err)
			}
			if err := native.ConfirmContinuationAdmission(admission, test.ack); !errors.Is(err, ErrNativeUnknown) {
				t.Fatal("unknown continuation was acknowledged", err)
			}
		})
	}
}

func TestNativeContinuationWithoutCallAndOversizedReplay(t *testing.T) {
	native, _, _, _ := nativeFixture(t)
	owner := work.ContinuationOwner{ConversationID: "current", ThreadID: "thread"}
	if !native.CanContinueWhileIdle(owner) {
		t.Fatal("no call blocked ordinary work")
	}
	admission, err := native.BeginContinuationAdmission(owner)
	if err != nil || admission.CallID != "" || admission.Owner != owner {
		t.Fatal("ordinary work unexpectedly acquired media", admission, err)
	}
	if err := native.ConfirmContinuationAdmission(admission, "turn"); err != nil {
		t.Fatal(err)
	}
	input := []runtime.Event{{Method: "notice", Params: object(map[string]any{"threadId": "thread"})}}
	result, conflict, err := native.ReplayContinuationEvents(t.Context(), admission, input, "", true)
	if err != nil || conflict || len(result) != 1 {
		t.Fatal("ordinary work lost its buffered event", result, conflict, err)
	}
	for _, events := range [][]runtime.Event{make([]runtime.Event, nativeEventLimit+1), {{Method: "notice", Params: object(map[string]any{"text": strings.Repeat("x", nativeEventByteLimit)})}}} {
		if _, conflict, err := native.ReplayContinuationEvents(t.Context(), admission, events, "", true); !conflict || !errors.Is(err, ErrNativeUnknown) {
			t.Fatal("oversized replay was admitted", conflict, err)
		}
	}
}
