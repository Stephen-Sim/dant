package work

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func inventoryIdle(t *testing.T, request fakeRequest) {
	t.Helper()
	if request.method != "thread/read" || eventString(request.params, "threadId") != "thread-fixture" || string(request.params["includeTurns"]) != "false" {
		t.Fatal("continuation requested hydrated history or a different thread")
	}
	request.result <- fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture","status":{"type":"idle"},"turns":[]}`)}}
}

func inventoryPage(t *testing.T, worker *fakeWorker, cursor string) fakeRequest {
	t.Helper()
	request := nextRequest(t, worker, "thread/turns/list")
	if eventString(request.params, "threadId") != "thread-fixture" || eventString(request.params, "itemsView") != "notLoaded" || eventString(request.params, "sortDirection") != "asc" || string(request.params["limit"]) != "50" || eventString(request.params, "cursor") != cursor {
		t.Fatal("inventory requested items, changed scope or lost its opaque cursor")
	}
	if cursor == "" {
		if _, present := request.params["cursor"]; present {
			t.Fatal("first page invented a cursor")
		}
	}
	return request
}

func inventoryTurn(id string) contracts.RawObject {
	return contracts.RawObject{"id": raw(id), "status": raw("interrupted"), "itemsView": raw("notLoaded"), "items": raw([]string{})}
}

func inventoryResponse(turns []contracts.RawObject, next any) fakeResponse {
	return fakeResponse{value: contracts.RawObject{"data": raw(turns), "nextCursor": raw(next), "backwardsCursor": raw(nil)}}
}

func assertInventoryFailure(t *testing.T, engine *Engine, persistence *store.Store, worker *fakeWorker, id, turn string, done <-chan error) {
	t.Helper()
	if err := awaitWorkAction(t, done); err == nil {
		t.Fatal("unconfirmed inventory admitted a turn")
	}
	state := persistence.Snapshot()
	record, err := store.FindWork(&state, id)
	if err != nil || record.TurnID != turn || record.Status != contracts.WorkStatusPaused || record.Continuation.Dispatch != nil || engine.Snapshot().Active != nil {
		t.Fatal("read-only failure changed the prior execution or retained a false submitted action", err)
	}
	assertWorkerQuiet(t, worker)
}

func TestContinuationInventoryPagesAllTurnsWithoutLoadingHistoricalImages(t *testing.T) {
	engine, persistence, worker, id, turn := selectedPausedFixture(t)
	read, done := selectedResumeRead(t, engine, worker, id, turn)
	inventoryIdle(t, read)
	cursor := ""
	for page := 0; page < 4; page++ {
		request := inventoryPage(t, worker, cursor)
		turns := []contracts.RawObject{}
		for index := 0; index < 40; index++ {
			turns = append(turns, inventoryTurn(fmt.Sprintf("historical-turn-%d-%d", page, index)))
		}
		var next any
		if page == 3 {
			turns = append(turns, inventoryTurn(turn))
		} else {
			cursor = fmt.Sprintf("opaque-page-%d", page)
			next = cursor
		}
		request.result <- inventoryResponse(turns, next)
	}
	// The source turn was on the LAST page. Neither partial inventory nor its
	// final cursor grants permission until a fresh metadata-only idle read.
	final := nextRequest(t, worker, "thread/read")
	assertWorkerQuiet(t, worker)
	inventoryIdle(t, final)
	start := nextRequest(t, worker, "turn/start")
	start.result <- fakeResponse{value: contracts.RawObject{"turn": raw(contracts.RawObject{"id": raw("paged-selected-result")})}}
	if err := awaitWorkAction(t, done); err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(t.Context(), terminal("paged-selected-result", "completed")); err != nil {
		t.Fatal(err)
	}
	state := persistence.Snapshot()
	record, _ := store.FindWork(&state, id)
	if record.TurnID != "paged-selected-result" || record.Continuation.Attempts != 1 {
		t.Fatal("complete inventory did not preserve the single selected attempt")
	}
}

func TestContinuationInventoryRejectsIncompleteAmbiguousOrHydratedPagesBeforeDispatch(t *testing.T) {
	for _, scenario := range []string{
		"request-error", "missing-data", "null-data", "malformed-data", "missing-cursor", "invalid-cursor", "empty-cursor", "oversize-cursor", "empty-with-cursor",
		"too-many-turns", "invalid-id", "nonterminal", "duplicate-in-page", "missing-original", "full-view", "missing-view", "hydrated-items", "null-items", "oversize-page",
		"duplicate-across-pages", "cursor-cycle", "late-nonterminal", "late-wrong-runtime", "late-wrong-conversation",
	} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker, id, turn := selectedPausedFixture(t)
			read, done := selectedResumeRead(t, engine, worker, id, turn)
			inventoryIdle(t, read)
			request := inventoryPage(t, worker, "")
			response := inventoryResponse([]contracts.RawObject{inventoryTurn(turn)}, nil)
			switch scenario {
			case "request-error":
				response.err = ErrBusy
			case "missing-data":
				delete(response.value, "data")
			case "null-data":
				response.value["data"] = raw(nil)
			case "malformed-data":
				response.value["data"] = raw(true)
			case "missing-cursor":
				delete(response.value, "nextCursor")
			case "invalid-cursor":
				response.value["nextCursor"] = raw(5)
			case "empty-cursor":
				response.value["nextCursor"] = raw("")
			case "oversize-cursor":
				response.value["nextCursor"] = raw(strings.Repeat("c", maxContinuationHistoryCursorBytes+1))
			case "empty-with-cursor":
				response = inventoryResponse([]contracts.RawObject{}, "next")
			case "too-many-turns":
				turns := []contracts.RawObject{}
				for index := 0; index <= continuationHistoryPageTurns; index++ {
					turns = append(turns, inventoryTurn(fmt.Sprintf("turn-%d", index)))
				}
				response.value["data"] = raw(turns)
			case "invalid-id", "nonterminal", "full-view", "missing-view", "hydrated-items", "null-items":
				item := inventoryTurn(turn)
				switch scenario {
				case "invalid-id":
					item["id"] = raw("")
				case "nonterminal":
					item["status"] = raw("inProgress")
				case "full-view":
					item["itemsView"] = raw("full")
				case "missing-view":
					delete(item, "itemsView")
				case "hydrated-items":
					item["items"] = raw([]contracts.RawObject{{"type": raw("image"), "data": raw("unrequested image fixture")}})
				case "null-items":
					item["items"] = raw(nil)
				}
				response.value["data"] = raw([]contracts.RawObject{item})
			case "duplicate-in-page":
				response.value["data"] = raw([]contracts.RawObject{inventoryTurn(turn), inventoryTurn(turn)})
			case "missing-original":
				response.value["data"] = raw([]contracts.RawObject{inventoryTurn("different-turn")})
			case "oversize-page":
				response.value["unused"] = raw(strings.Repeat("p", maxContinuationHistoryPageBytes))
			default:
				response.value["nextCursor"] = raw("next")
			}
			request.result <- response
			switch scenario {
			case "duplicate-across-pages", "cursor-cycle", "late-nonterminal", "late-wrong-runtime", "late-wrong-conversation":
				request = inventoryPage(t, worker, "next")
				response = inventoryResponse([]contracts.RawObject{inventoryTurn("different-turn")}, nil)
				switch scenario {
				case "duplicate-across-pages":
					response.value["data"] = raw([]contracts.RawObject{inventoryTurn(turn)})
				case "cursor-cycle":
					response.value["nextCursor"] = raw("next")
				case "late-nonterminal":
					item := inventoryTurn("different-turn")
					item["status"] = raw("inProgress")
					response.value["data"] = raw([]contracts.RawObject{item})
				default:
					if err := persistence.Mutate(t.Context(), func(state *contracts.State) error {
						if scenario == "late-wrong-runtime" {
							state.ThreadRuntime = contracts.Some("replacement-runtime")
						} else {
							state.ThreadConversationID = "replacement-conversation"
						}
						return nil
					}); err != nil {
						t.Fatal(err)
					}
				}
				request.result <- response
			}
			assertInventoryFailure(t, engine, persistence, worker, id, turn, done)
		})
	}
}

func TestContinuationInventoryFreshIdleProofCannotBeReplacedByEarlierIdle(t *testing.T) {
	for _, scenario := range []string{"busy", "wrong-thread", "hydrated", "read-error", "takeover"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker, id, turn := selectedPausedFixture(t)
			read, done := selectedResumeRead(t, engine, worker, id, turn)
			inventoryIdle(t, read)
			request := inventoryPage(t, worker, "")
			request.result <- inventoryResponse([]contracts.RawObject{inventoryTurn(turn)}, nil)
			final := nextRequest(t, worker, "thread/read")
			response := fakeResponse{value: contracts.RawObject{"thread": json.RawMessage(`{"id":"thread-fixture","status":{"type":"idle"},"turns":[]}`)}}
			switch scenario {
			case "busy":
				response.value["thread"] = json.RawMessage(`{"id":"thread-fixture","status":{"type":"active"},"turns":[]}`)
			case "wrong-thread":
				response.value["thread"] = json.RawMessage(`{"id":"other-thread","status":{"type":"idle"},"turns":[]}`)
			case "hydrated":
				response.value["thread"] = json.RawMessage(`{"id":"thread-fixture","status":{"type":"idle"},"turns":[{"id":"unrequested-turn"}]}`)
			case "read-error":
				response.err = ErrBusy
			case "takeover":
				engine.mu.Lock()
				engine.takeover = true
				engine.mu.Unlock()
			}
			final.result <- response
			assertInventoryFailure(t, engine, persistence, worker, id, turn, done)
		})
	}
}

func TestContinuationInventoryHasFiniteTurnPageAndByteBudgets(t *testing.T) {
	for _, scenario := range []string{"turns", "pages", "bytes"} {
		t.Run(scenario, func(t *testing.T) {
			engine, persistence, worker, id, turn := selectedPausedFixture(t)
			read, done := selectedResumeRead(t, engine, worker, id, turn)
			inventoryIdle(t, read)
			requests := 0
			var failure error
			finished := false
			for !finished {
				select {
				case failure = <-done:
					finished = true
				case request := <-worker.requests:
					if request.method != "thread/turns/list" {
						t.Fatal("over-budget inventory advanced to another operation", request.method)
					}
					requests++
					if requests > maxContinuationHistoryPages+1 {
						t.Fatal("inventory has no finite page bound")
					}
					count := 1
					if scenario == "turns" {
						count = continuationHistoryPageTurns
					}
					turns := []contracts.RawObject{}
					for index := 0; index < count; index++ {
						turns = append(turns, inventoryTurn(fmt.Sprintf("bounded-%d-%d", requests, index)))
					}
					response := inventoryResponse(turns, fmt.Sprintf("cursor-%d", requests))
					if scenario == "bytes" {
						response.value["metadata"] = raw(strings.Repeat("m", maxContinuationHistoryPageBytes-1024))
					}
					request.result <- response
				case <-time.After(10 * time.Second):
					t.Fatal("bounded inventory did not settle")
				}
			}
			if failure == nil || requests == 0 || scenario == "bytes" && requests >= 40 || scenario == "turns" && requests > maxContinuationHistoryTurns/continuationHistoryPageTurns+1 {
				t.Fatal("inventory exceeded its finite resource budget", failure, requests)
			}
			state := persistence.Snapshot()
			record, _ := store.FindWork(&state, id)
			if record.Status != contracts.WorkStatusPaused || record.TurnID != turn || record.Continuation.Dispatch != nil || engine.Snapshot().Active != nil {
				t.Fatal("budget rejection changed execution authority")
			}
			assertWorkerQuiet(t, worker)
		})
	}
}

func TestContinuationInventoryCancellationJoinsTheReadWithoutSubmittingWork(t *testing.T) {
	engine, persistence, worker, id, turn := selectedPausedFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := engine.ResumeProgress(ctx, id, store.ProgressWork, turn)
		done <- err
	}()
	resume := nextRequest(t, worker, "thread/resume")
	resume.result <- fakeResponse{value: contracts.RawObject{}}
	inventoryIdle(t, nextRequest(t, worker, "thread/read"))
	page := inventoryPage(t, worker, "")
	page.result <- inventoryResponse([]contracts.RawObject{inventoryTurn(turn)}, "remaining-history")
	_ = inventoryPage(t, worker, "remaining-history")
	cancel()
	assertInventoryFailure(t, engine, persistence, worker, id, turn, done)
}
