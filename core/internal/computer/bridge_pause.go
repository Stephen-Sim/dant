package computer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const vmPauseTimeout = 45 * time.Second
const pauseReceiptByteLimit = 8192
const pauseReceiptEntryLimit = 64

var ErrPauseUnconfirmed = errors.New("vm_pause_unconfirmed")

type pauseReceipt struct {
	SchemaVersion int      `json:"schemaVersion"`
	Entries       []string `json:"entries"`
}

func nodeJSONString(value string) string {
	var output strings.Builder
	output.WriteByte('"')
	for _, rune := range value {
		switch rune {
		case '"', '\\':
			output.WriteByte('\\')
			output.WriteRune(rune)
		case '\b':
			output.WriteString(`\b`)
		case '\f':
			output.WriteString(`\f`)
		case '\n':
			output.WriteString(`\n`)
		case '\r':
			output.WriteString(`\r`)
		case '\t':
			output.WriteString(`\t`)
		default:
			if rune < 0x20 {
				output.WriteString(`\u`)
				output.WriteString("00")
				output.WriteByte("0123456789abcdef"[byte(rune)>>4])
				output.WriteByte("0123456789abcdef"[byte(rune)&15])
			} else {
				output.WriteRune(rune)
			}
		}
	}
	output.WriteByte('"')
	return output.String()
}

// BindingRecordDigest preserves the historical VM backup target identity,
// including JSON property order and JavaScript's UTF-8 escaping behavior.
func BindingRecordDigest(binding Binding) string {
	value := `{"host":` + nodeJSONString(binding.Host) + `,"user":` + nodeJSONString(binding.User) + `,"port":` + strconv.Itoa(binding.Port) + `,"keyPath":` + nodeJSONString(binding.KeyPath) + `,"knownHosts":` + nodeJSONString(binding.KnownHosts)
	for _, field := range []struct{ name, value string }{{"provider", string(binding.Provider)}, {"name", binding.Name}, {"vmxPath", binding.VMXPath}, {"vmwareId", binding.VMwareID}} {
		if field.value != "" {
			value += `,` + nodeJSONString(field.name) + `:` + nodeJSONString(field.value)
		}
	}
	value += `}`
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// BindingIdentity retains the legacy JSON-array identity used by pause/backup receipts.
func BindingIdentity(binding Binding) string {
	return "[" + nodeJSONString(binding.Host) + "," + nodeJSONString(binding.User) + "," + strconv.Itoa(binding.Port) + "," + nodeJSONString(binding.KeyPath) + "," + nodeJSONString(binding.KnownHosts) + "]"
}

func BindingDigest(binding Binding) string {
	sum := sha256.Sum256([]byte(BindingIdentity(binding)))
	return hex.EncodeToString(sum[:])
}

func (bridge *VMBridge) pauseReceipt(ctx context.Context, binding Binding, action string) (bool, error) {
	file := filepath.Join(bridge.options.DataDir, "vm-work-pause.json")
	digest := BindingDigest(binding)
	receipt := pauseReceipt{SchemaVersion: 1, Entries: []string{}}
	raw, err := files.ReadRegular(file, pauseReceiptByteLimit)
	if err == nil {
		if _, err := contracts.DecodeObject(raw, pauseReceiptByteLimit); err != nil {
			return false, ErrPauseUnconfirmed
		}
		if json.Unmarshal(raw, &receipt) != nil || receipt.SchemaVersion != 1 || receipt.Entries == nil || len(receipt.Entries) > pauseReceiptEntryLimit {
			return false, ErrPauseUnconfirmed
		}
		for _, entry := range receipt.Entries {
			if !bindingDigest.MatchString(entry) {
				return false, ErrPauseUnconfirmed
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, ErrPauseUnconfirmed
	}
	found := false
	next := []string{}
	for _, entry := range receipt.Entries {
		if entry == digest {
			found = true
		} else {
			next = append(next, entry)
		}
	}

	if action == "read" {
		return found, nil
	}

	if action == "start" {
		if len(next) >= pauseReceiptEntryLimit {
			return false, ErrPauseUnconfirmed
		}
		next = append(next, digest)
	} else if action != "clear" {
		return false, ErrPauseUnconfirmed
	}
	encoded, _ := json.Marshal(pauseReceipt{SchemaVersion: 1, Entries: next})
	if err := files.WriteAtomic(ctx, file, encoded, 0600); err != nil {
		return false, ErrPauseUnconfirmed
	}

	return found, nil
}

func unresolvedPause(status, id, turnID string, unknown bool, submission contracts.Optional[contracts.SubmissionStatus], continuation *contracts.WorkContinuation, active *contracts.ActiveExecution) bool {
	value, _ := submission.Get()
	if unknown || value == contracts.SubmissionStatusUnknown || value == contracts.SubmissionStatusSubmitting || status == string(contracts.TaskStatusUnknown) {
		return true
	}

	if continuation == nil {
		return false
	}

	if continuation.Invalid {
		return true
	}

	if continuation.Dispatch == nil {
		return false
	}
	phase := string(continuation.Dispatch.Phase)
	if phase != "accepted" && phase != string(contracts.ContinuationDispatchPhaseAcknowledged) {
		return true
	}

	if active == nil {
		return true
	}
	activeTurn, _ := active.TurnID.Get()
	return turnID != activeTurn && id != active.WorkID
}

func unresolvedState(state contracts.WorkerSnapshot) bool {
	for _, message := range state.Messages {
		if message == nil {
			return true
		}
		status, _ := message.Status.Get()
		turn, _ := message.TurnID.Get()
		if unresolvedPause(string(status), message.ID, turn, message.UnknownOutcome, message.Submission, message.Continuation, state.Active) {
			return true
		}
	}
	for _, work := range state.WorkTasks {
		if unresolvedPause(string(work.Status), work.ID, work.TurnID, work.UnknownOutcome, work.Submission, work.Continuation, state.Active) {
			return true
		}
	}

	return false
}

func pauseSnapshotSafe(state contracts.WorkerSnapshot, allowHuman bool) bool {
	if state.Messages == nil || state.WorkTasks == nil || state.Queue == nil || state.Acquiring || state.Worker.Status != contracts.ConnectionStatusOnline {
		return false
	}
	var computer controlObservation
	if json.Unmarshal(state.Extra["computer"], &computer) != nil || computer.Pending || computer.Acquiring {
		return false
	}
	human := allowHuman && state.Takeover && computer.Status == contracts.ComputerControlStatusHuman && computer.SessionID != nil && len(*computer.SessionID) > 0 && len(*computer.SessionID) <= 256
	return human || (!state.Takeover && computer.Status == contracts.ComputerControlStatusDant && (computer.SessionID == nil || *computer.SessionID == ""))
}

func (bridge *VMBridge) PauseWorkForUpdate(ctx context.Context, reason string) error {
	if reason != "install" && reason != "exit" {
		return ErrPauseUnconfirmed
	}

	if !bridge.pauseMu.TryLock() {
		return ErrBridgeBusy
	}
	defer bridge.pauseMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, vmPauseTimeout)
	defer cancel()
	binding, err := ReadBinding(bridge.options.DataDir)
	if err != nil {
		return ErrPauseUnconfirmed
	}
	identity := BindingIdentity(binding)
	generation := bridge.Generation()
	current := func() error {
		if ctx.Err() != nil || bridge.Status() != contracts.ConnectionStatusOnline || bridge.Generation() != generation {
			return ErrPauseUnconfirmed
		}
		value, err := ReadBinding(bridge.options.DataDir)
		if err != nil || BindingIdentity(value) != identity {
			return ErrPauseUnconfirmed
		}
		return nil
	}
	snapshot := func(allowHuman bool) (contracts.WorkerSnapshot, error) {
		if err := current(); err != nil {
			return contracts.WorkerSnapshot{}, err
		}
		state, err := bridge.Refresh(ctx)
		if err != nil || current() != nil || !pauseSnapshotSafe(state, allowHuman) {
			return contracts.WorkerSnapshot{}, ErrPauseUnconfirmed
		}
		return state, nil
	}
	post := func(route string, body any, receipt string) error {
		if err := current(); err != nil {
			return err
		}
		raw, err := json.Marshal(body)
		if err != nil {
			return ErrPauseUnconfirmed
		}
		response, err := bridge.Request(ctx, http.MethodPost, route, http.Header{"Content-Type": []string{"application/json"}}, bytes.NewReader(raw))
		if err != nil {
			return ErrPauseUnconfirmed
		}
		defer response.Body.Close()
		value, err := io.ReadAll(io.LimitReader(response.Body, 65537))
		if err != nil || len(value) > 65536 || response.StatusCode < 200 || response.StatusCode >= 300 || current() != nil {
			return ErrPauseUnconfirmed
		}
		if _, err := contracts.DecodeObject(value, 65536); err != nil {
			return ErrPauseUnconfirmed
		}
		var result struct {
			OK      bool `json:"ok"`
			Paused  bool `json:"paused"`
			Stopped bool `json:"stopped"`
		}
		if json.Unmarshal(value, &result) != nil {
			return ErrPauseUnconfirmed
		}
		if (receipt == "ok" && !result.OK) || (receipt == "paused" && (!result.OK || !result.Paused)) || (receipt == "stopped" && !result.Stopped) {
			return ErrPauseUnconfirmed
		}
		return nil
	}
	state, err := snapshot(true)
	if err != nil {
		return err
	}
	pending, err := bridge.pauseReceipt(ctx, binding, "read")
	if err != nil {
		return err
	}

	if pending {
		if !ServiceUpdateQuiescent(state, false) {
			return ErrPauseUnconfirmed
		}
		_, err := bridge.pauseReceipt(ctx, binding, "clear")
		return err
	}

	if unresolvedState(state) {
		return ErrPauseUnconfirmed
	}
	callID := ""
	if state.Call != nil {
		callID = state.Call.ID
		if callID == "" || len(callID) > 256 {
			return ErrPauseUnconfirmed
		}
	}

	if _, err := bridge.pauseReceipt(ctx, binding, "start"); err != nil {
		return err
	}

	if state.Takeover {
		var control controlObservation
		json.Unmarshal(state.Extra["computer"], &control)
		if err := post("/api/takeover", struct {
			Enabled   bool    `json:"enabled"`
			SessionID *string `json:"sessionId"`
		}{false, control.SessionID}, "ok"); err != nil {
			return err
		}
		state, err = snapshot(false)
		if err != nil {
			return err
		}
	}

	if err := post("/api/tasks/pause", struct{}{}, "ok"); err != nil {
		return err
	}
	state, err = snapshot(false)
	if err != nil {
		return err
	}

	if state.Call != nil {
		if callID == "" || state.Call.ID != callID {
			return ErrPauseUnconfirmed
		}
		if err := post("/api/call/stop", struct {
			CallID string `json:"callId"`
		}{callID}, "stopped"); err != nil {
			return err
		}
	}

	if err := post("/api/tasks/pause", struct{}{}, "ok"); err != nil {
		return err
	}
	state, err = snapshot(false)
	if err != nil {
		return err
	}

	if state.Active != nil || state.Call != nil || len(state.Queue) > 0 || unresolvedState(state) {
		return ErrPauseUnconfirmed
	}
	for _, work := range state.WorkTasks {
		if work.Status != contracts.WorkStatusContinuing && string(work.Status) != string(contracts.TaskStatusWaitingUser) {
			continue
		}
		if work.ID == "" || len(work.ID) > 128 || work.TurnID == "" || len(work.TurnID) > 256 || (work.Continuation != nil && work.Continuation.Dispatch != nil) {
			return ErrPauseUnconfirmed
		}
		if err := post("/api/tasks/"+url.PathEscape(work.ID)+"/pause", struct {
			Kind   string `json:"kind"`
			TurnID string `json:"turnId"`
		}{"work", work.TurnID}, "paused"); err != nil {
			return err
		}
	}

	if err := post("/api/connect", struct {
		IdleRecovery bool `json:"idleRecovery"`
	}{true}, "ok"); err != nil {
		return err
	}
	state, err = snapshot(false)
	if err != nil || !ServiceUpdateQuiescent(state, false) {
		return ErrPauseUnconfirmed
	}
	_, err = bridge.pauseReceipt(ctx, binding, "clear")
	return err
}
