package work

import (
	"context"
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/runtime"
	workstate "github.com/Stephen-Sim/dant/core/internal/work/state"
)

const (
	continuationHistoryPageTurns      = 50
	maxContinuationHistoryTurns       = 10000
	maxContinuationHistoryPages       = 1000
	maxContinuationHistoryPageBytes   = 256 * 1024
	maxContinuationHistoryBytes       = 8 * 1024 * 1024
	maxContinuationHistoryCursorBytes = 4096
)

// continuationHistory reads only turn identities and terminal states. Hydrating
// items also loads historical screenshots, which can exceed the RPC frame bound.
// The cursor must reach its explicit end before this inventory can admit work.
func (value *Engine) continuationHistory(active *execution) ([]string, error) {
	ctx, cancel := context.WithTimeout(active.prepare, runtime.RequestTimeout)
	defer cancel()

	current := func() bool {
		if ctx.Err() != nil {
			return false
		}
		value.mu.Lock()
		defer value.mu.Unlock()
		state := value.store.Snapshot()
		return value.currentLocked(active) && !active.finishing && !active.stopRequested && !active.unknown &&
			!value.takeover && !value.acquiring && !value.maintenance &&
			value.worker.Snapshot().Status == contracts.ConnectionStatusOnline && value.worker.RuntimeID() == active.runtimeID &&
			state.ThreadID.Value == active.threadID && state.ThreadRuntime.Value == active.runtimeID && state.ThreadConversationID == active.conversationID
	}
	bytesRead := 0
	request := func(method string, params contracts.RawObject) (contracts.RawObject, error) {
		result, err := value.requestOwned(ctx, method, params, current)
		if err != nil {
			return nil, err
		}
		if !current() {
			return nil, ErrStaleOwner
		}
		encoded, err := json.Marshal(result)
		if err != nil || len(encoded) > maxContinuationHistoryPageBytes {
			return nil, ErrStaleOwner
		}
		bytesRead += len(encoded)
		if bytesRead > maxContinuationHistoryBytes {
			return nil, ErrStaleOwner
		}
		return result, nil
	}
	readIdle := func() error {
		result, err := request("thread/read", contracts.RawObject{"threadId": raw(active.threadID), "includeTurns": raw(false)})
		if err != nil {
			return err
		}
		thread, err := contracts.DecodeObject(result["thread"], maxContinuationHistoryPageBytes)
		if err != nil || eventString(thread, "id") != active.threadID {
			return ErrStaleOwner
		}
		status, err := contracts.DecodeObject(thread["status"], maxContinuationHistoryPageBytes)
		if err != nil || eventString(status, "type") != "idle" {
			return ErrBusy
		}
		if encoded, present := thread["turns"]; present {
			var turns []json.RawMessage
			if json.Unmarshal(encoded, &turns) != nil || turns == nil || len(turns) != 0 {
				return ErrStaleOwner
			}
		}
		return nil
	}
	if err := readIdle(); err != nil {
		return nil, err
	}

	seen := make(map[string]bool)
	turns := []string{}
	cursors := make(map[string]bool)
	cursor := ""
	complete := false
	for page := 0; page < maxContinuationHistoryPages; page++ {
		params := contracts.RawObject{
			"threadId": raw(active.threadID), "limit": raw(continuationHistoryPageTurns),
			"sortDirection": raw("asc"), "itemsView": raw("notLoaded"),
		}
		if cursor != "" {
			params["cursor"] = raw(cursor)
		}
		result, err := request("thread/turns/list", params)
		if err != nil {
			return nil, err
		}
		var data []json.RawMessage
		if json.Unmarshal(result["data"], &data) != nil || data == nil || len(data) > continuationHistoryPageTurns || len(turns)+len(data) > maxContinuationHistoryTurns {
			return nil, ErrStaleOwner
		}
		for _, encoded := range data {
			turn, err := contracts.DecodeObject(encoded, maxContinuationHistoryPageBytes)
			id := eventString(turn, "id")
			if err != nil || !workstate.ValidID(id, workstate.ReferenceIDLength) || seen[id] || !contracts.RuntimeTerminalTurnStatus(eventString(turn, "status")).Valid() {
				return nil, ErrBusy
			}
			var items []json.RawMessage
			if eventString(turn, "itemsView") != "notLoaded" || json.Unmarshal(turn["items"], &items) != nil || items == nil || len(items) != 0 {
				return nil, ErrStaleOwner
			}
			seen[id] = true
			turns = append(turns, id)
		}
		var next contracts.Optional[string]
		if encoded, present := result["nextCursor"]; !present || json.Unmarshal(encoded, &next) != nil || !next.Present {
			return nil, ErrStaleOwner
		}
		if next.Null {
			complete = true
			break
		}
		if len(data) == 0 || next.Value == "" || len(next.Value) > maxContinuationHistoryCursorBytes || cursors[next.Value] {
			return nil, ErrStaleOwner
		}
		cursor = next.Value
		cursors[cursor] = true
	}
	if !complete || !seen[active.fromTurnID] {
		return nil, ErrStaleOwner
	}

	// Paging is read-only and does not reserve the remote executor. Recheck idle
	// metadata after the final page; the existing owned dispatch checks still run
	// immediately before the sole turn/start.
	if err := readIdle(); err != nil {
		return nil, err
	}
	return turns, nil
}
