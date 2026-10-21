package backups

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type backupBridgeFixture struct {
	status     contracts.ConnectionStatus
	generation uint64
	state      contracts.WorkerSnapshot
	refresh    func(context.Context) (contracts.WorkerSnapshot, error)
	request    func(context.Context, string, string) (*http.Response, error)
	pause      func(context.Context) error
	connect    func(context.Context) error
	pauses     int
	connects   int
}

func (bridge *backupBridgeFixture) Status() contracts.ConnectionStatus { return bridge.status }
func (bridge *backupBridgeFixture) Generation() uint64                 { return bridge.generation }
func (bridge *backupBridgeFixture) Snapshot() contracts.WorkerSnapshot { return bridge.state }
func (bridge *backupBridgeFixture) Refresh(ctx context.Context) (contracts.WorkerSnapshot, error) {
	if bridge.refresh != nil {
		return bridge.refresh(ctx)
	}
	return bridge.state, nil
}
func (bridge *backupBridgeFixture) Request(ctx context.Context, method, route string, _ http.Header, input io.Reader) (*http.Response, error) {
	if input != nil {
		return nil, errors.New("unexpected request input")
	}
	return bridge.request(ctx, method, route)
}
func (bridge *backupBridgeFixture) PauseWorkForUpdate(ctx context.Context, reason string) error {
	bridge.pauses++
	if reason != "install" {
		return errors.New("unexpected pause reason")
	}
	if bridge.pause != nil {
		return bridge.pause(ctx)
	}
	return nil
}
func (bridge *backupBridgeFixture) Connect(ctx context.Context, deploy bool) error {
	bridge.connects++
	if deploy {
		return errors.New("restore must not deploy a source")
	}
	if bridge.connect != nil {
		return bridge.connect(ctx)
	}
	return nil
}

type backupBodyFixture struct {
	io.Reader
	closed bool
}

func (body *backupBodyFixture) Close() error {
	body.closed = true
	return nil
}

func vmBackupFixture(t *testing.T) (*VMTransport, *backupBridgeFixture, *computer.Binding, Target) {
	t.Helper()
	binding := &computer.Binding{Host: "192.0.2.1", User: "isolated", Port: 22, KeyPath: filepath.Join(t.TempDir(), "key"), KnownHosts: filepath.Join(t.TempDir(), "known_hosts")}
	bridge := &backupBridgeFixture{
		status:     contracts.ConnectionStatusOnline,
		generation: 4,
		state: contracts.WorkerSnapshot{
			Messages:  []*contracts.ChatMessage{},
			WorkTasks: []contracts.WorkRecord{},
			Queue:     []string{},
			Worker:    contracts.WorkerState{Status: contracts.ConnectionStatusOnline},
			Extra: contracts.RawObject{
				"computer":     json.RawMessage(`{"status":"dant","pending":false,"acquiring":false}`),
				"capabilities": json.RawMessage(`{"backups":true}`),
			},
		},
	}
	transport, err := NewVMTransport(VMTransportOptions{
		Bridge: bridge,
		Binding: func() (computer.Binding, error) {
			return *binding, nil
		},
		Run: func(context.Context, string, []string, io.Reader) ([]byte, error) {
			t.Fatal("unexpected subprocess dispatch")
			return nil, ErrInvalid
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	target, err := transport.Target(t.Context(), false)
	if err != nil || !target.Online || !target.Supported {
		t.Fatal("invalid isolated target")
	}
	return transport, bridge, binding, target
}

func TestVMBackupTargetRetainsConnectionAndCapabilityAuthority(t *testing.T) {
	if _, err := NewVMTransport(VMTransportOptions{}); !errors.Is(err, ErrInvalid) {
		t.Fatal("missing boundaries accepted")
	}
	transport, bridge, binding, target := vmBackupFixture(t)
	bridge.refresh = func(context.Context) (contracts.WorkerSnapshot, error) {
		binding.Host = "192.0.2.2"
		return bridge.state, nil
	}
	if _, err := transport.Target(t.Context(), true); !errors.Is(err, ErrConnectionChanged) {
		t.Fatal("refresh applied another VM's result")
	}
	bridge.refresh = func(context.Context) (contracts.WorkerSnapshot, error) {
		return contracts.WorkerSnapshot{}, context.Canceled
	}
	if _, err := transport.Target(t.Context(), true); !errors.Is(err, context.Canceled) {
		t.Fatal("refresh cancellation was hidden")
	}
	transport.options.Binding = func() (computer.Binding, error) { return computer.Binding{}, computer.ErrBindingMissing }
	missing, err := transport.Target(t.Context(), true)
	if err != nil || missing.Identity != "" || missing.Online || missing.Supported || missing.Generation != target.Generation {
		t.Fatal("missing binding invented a usable target")
	}
}

func TestVMBackupExportValidatesMetadataAndAlwaysReleasesRejectedBodies(t *testing.T) {
	metadata := Metadata{ID: "", Source: "", CreatedAt: 1000, AppVersion: "0.4.7-beta.20", Bytes: 2, Files: 1}
	valid, _ := json.Marshal(metadata)
	for _, test := range []struct {
		name   string
		status int
		header string
		want   error
	}{
		{"busy", 409, "", ErrBusy},
		{"legacy", 404, "", ErrServiceUpdate},
		{"server", 500, "", ErrInvalid},
		{"missing", 200, "", ErrInvalid},
		{"large", 200, strings.Repeat("A", 4097), ErrInvalid},
		{"base64", 200, "!", ErrInvalid},
		{"noncanonical", 200, base64.StdEncoding.EncodeToString(valid) + "\n", ErrInvalid},
		{"json", 200, base64.StdEncoding.EncodeToString([]byte(`{"id":1,"id":2}`)), ErrInvalid},
		{"types", 200, base64.StdEncoding.EncodeToString([]byte(`{"files":"one"}`)), ErrInvalid},
		{"bounds", 200, base64.StdEncoding.EncodeToString([]byte(`{"files":100001,"bytes":1,"createdAt":1,"appVersion":"0.4.7-beta.20"}`)), ErrInvalid},
		{"accepted", 200, base64.StdEncoding.EncodeToString(valid), nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			transport, bridge, _, _ := vmBackupFixture(t)
			body := &backupBodyFixture{Reader: strings.NewReader("archive")}
			bridge.request = func(_ context.Context, method, route string) (*http.Response, error) {
				if method != http.MethodGet || route != "/api/backups/export" {
					t.Fatal("unexpected export request")
				}
				return &http.Response{StatusCode: test.status, Header: http.Header{"X-Dant-Backup-Metadata": []string{test.header}}, Body: body}, nil
			}
			source, err := transport.Export(t.Context())
			if !errors.Is(err, test.want) {
				t.Fatalf("unexpected result %v", err)
			}
			if test.want != nil {
				if !body.closed {
					t.Fatal("rejected response leaked body")
				}
				return
			}
			if body.closed || source.Metadata != metadata {
				t.Fatal("accepted export changed metadata or prematurely closed stream")
			}
			_ = source.Stream.Close()
		})
	}
	transport, bridge, _, _ := vmBackupFixture(t)
	bridge.request = func(context.Context, string, string) (*http.Response, error) { return nil, context.Canceled }
	if _, err := transport.Export(t.Context()); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled request ignored")
	}
}

func TestVMBackupRestoreDispatchesOnlyAfterExactPauseAndNeverReplaysUnknown(t *testing.T) {
	for _, failure := range []string{"none", "id", "binding", "pause", "refresh", "active", "generation", "ssh", "oversized", "malformed", "wrong-receipt", "changed-after-dispatch", "connect"} {
		t.Run(failure, func(t *testing.T) {
			transport, bridge, binding, target := vmBackupFixture(t)
			id := testRestoreID
			calls := 0
			switch failure {
			case "id":
				id = "unsafe; command"
			case "binding":
				binding.Host = "192.0.2.2"
			case "pause":
				bridge.pause = func(context.Context) error { return context.Canceled }
			case "refresh":
				bridge.refresh = func(context.Context) (contracts.WorkerSnapshot, error) { return bridge.state, context.Canceled }
			case "active":
				bridge.state.Queue = []string{"owned-task"}
			case "generation":
				bridge.refresh = func(context.Context) (contracts.WorkerSnapshot, error) {
					bridge.generation++
					return bridge.state, nil
				}
			case "connect":
				bridge.connect = func(context.Context) error { return context.Canceled }
			}
			transport.options.Run = func(ctx context.Context, executable string, args []string, input io.Reader) ([]byte, error) {
				calls++
				if executable != "ssh" || len(args) == 0 || !strings.Contains(args[len(args)-1], "systemctl --user stop dant-worker.service") || !strings.Contains(args[len(args)-1], "--role=backup-cli restore") || !strings.Contains(args[len(args)-1], "--role=backup-cli finish") {
					t.Fatal("restore did not use fixed stop/restore/finish command")
				}
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("unbounded SSH operation")
				}
				raw, _ := io.ReadAll(input)
				if string(raw) != "private archive" {
					t.Fatal("archive input was lost")
				}
				switch failure {
				case "ssh":
					return nil, errors.New("private remote failure")
				case "oversized":
					return bytes.Repeat([]byte{' '}, 4097), nil
				case "malformed":
					return []byte(`{"restored":`), nil
				case "wrong-receipt":
					return []byte(`{"restored":true,"restoreId":"other"}`), nil
				case "changed-after-dispatch":
					bridge.generation++
				}
				return json.Marshal(RestoreReceipt{Restored: true, RestoreID: id})
			}
			err := transport.Restore(t.Context(), strings.NewReader("private archive"), id, target)
			beforeDispatch := failure == "id" || failure == "binding" || failure == "pause" || failure == "refresh" || failure == "active" || failure == "generation"
			if beforeDispatch && (calls != 0 || err == nil) {
				t.Fatal("unconfirmed owner crossed dispatch boundary")
			}
			if !beforeDispatch && calls != 1 {
				t.Fatal("restore replayed or omitted external action")
			}
			if failure == "none" && (err != nil || bridge.connects != 1) {
				t.Fatal("acknowledged restore did not reconnect without deployment")
			}
			if failure != "none" && err == nil {
				t.Fatal("failure invented successful restoration")
			}
			if strings.Contains(failure, "dispatch") || failure == "ssh" || failure == "oversized" || failure == "malformed" || failure == "wrong-receipt" {
				if !errors.Is(err, ErrRestoreUnconfirmed) || bridge.connects != 0 {
					t.Fatal("unknown remote result became safe replay or reconnect")
				}
			}
		})
	}
}

func TestVMBackupReconciliationAndRejectionRequireIndependentLoadedProof(t *testing.T) {
	for _, mode := range []string{"loaded", "finish", "finish-unknown", "finish-wrong", "connect-fails", "not-loaded", "info-large", "info-error", "offline", "changed", "rejected", "not-rejected", "outcome-wrong", "binding", "id"} {
		t.Run(mode, func(t *testing.T) {
			transport, bridge, binding, target := vmBackupFixture(t)
			id := testRestoreID
			if mode == "id" {
				id = "invalid"
			}
			if mode == "binding" {
				binding.User = "other"
			}
			if mode == "offline" {
				bridge.status = contracts.ConnectionStatusOffline
			}
			requests, commands, closed := 0, 0, []*backupBodyFixture{}
			bridge.request = func(context.Context, string, string) (*http.Response, error) {
				requests++
				if mode == "info-error" {
					return nil, context.Canceled
				}
				loaded := mode == "loaded" || (commands > 0 && mode != "not-loaded")
				raw, _ := json.Marshal(RestoreReceipt{Restored: loaded, RestoreID: id})
				if mode == "info-large" {
					raw = bytes.Repeat([]byte{' '}, 4097)
				}
				body := &backupBodyFixture{Reader: bytes.NewReader(raw)}
				closed = append(closed, body)
				return &http.Response{StatusCode: http.StatusOK, Body: body}, nil
			}
			bridge.connect = func(context.Context) error {
				if mode == "connect-fails" {
					return context.Canceled
				}
				bridge.status = contracts.ConnectionStatusOnline
				return nil
			}
			transport.options.Run = func(_ context.Context, executable string, args []string, input io.Reader) ([]byte, error) {
				commands++
				if executable != "ssh" || input != nil || strings.Contains(args[len(args)-1], "backup-cli restore") {
					t.Fatal("reconciliation repeated restore input")
				}
				if mode == "finish-unknown" {
					return nil, context.DeadlineExceeded
				}
				if mode == "changed" {
					bridge.generation++
				}
				if mode == "finish-wrong" || mode == "outcome-wrong" {
					return []byte(`{"restoreId":"other"}`), nil
				}
				if strings.Contains(args[len(args)-1], "backup-cli outcome") {
					return json.Marshal(RestoreRejection{Rejected: mode == "rejected", RestoreID: id})
				}
				return json.Marshal(RestoreReceipt{Restored: true, RestoreID: id})
			}
			var confirmed bool
			var err error
			if mode == "rejected" || mode == "not-rejected" || mode == "outcome-wrong" {
				confirmed, err = transport.Rejected(t.Context(), id, target)
			} else {
				confirmed, err = transport.Reconcile(t.Context(), id, target)
			}
			want := mode == "loaded" || mode == "finish" || mode == "offline" || mode == "rejected"
			if confirmed != want || (want && err != nil) || commands > 1 {
				t.Fatalf("unconfirmed proof accepted or replayed: confirmed=%v error=%v commands=%d", confirmed, err, commands)
			}
			if mode == "loaded" && commands != 0 {
				t.Fatal("already loaded restore reran remote action")
			}
			for _, body := range closed {
				if !body.closed {
					t.Fatal("inspection response body leaked")
				}
			}
		})
	}
}
