package backups

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/platform"
)

type VMBackupBridge interface {
	Status() contracts.ConnectionStatus
	Generation() uint64
	Snapshot() contracts.WorkerSnapshot
	Refresh(context.Context) (contracts.WorkerSnapshot, error)
	Request(context.Context, string, string, http.Header, io.Reader) (*http.Response, error)
	PauseWorkForUpdate(context.Context, string) error
	Connect(context.Context, bool) error
}

type VMTransportOptions struct {
	Bridge  VMBackupBridge
	Binding func() (computer.Binding, error)
	Run     func(context.Context, string, []string, io.Reader) ([]byte, error)
	Version func() *string
}

type VMTransport struct{ options VMTransportOptions }

func NewVMTransport(options VMTransportOptions) (*VMTransport, error) {
	if options.Bridge == nil || options.Binding == nil {
		return nil, ErrInvalid
	}

	if options.Run == nil {
		options.Run = platform.Run
	}

	if options.Version == nil {
		options.Version = func() *string { return nil }
	}

	return &VMTransport{options: options}, nil
}

func (transport *VMTransport) current(binding computer.Binding, generation uint64) bool {
	current, err := transport.options.Binding()
	return err == nil && current == binding && generation == transport.options.Bridge.Generation()
}

func (transport *VMTransport) Target(ctx context.Context, refresh bool) (Target, error) {
	binding, err := transport.options.Binding()
	generation := transport.options.Bridge.Generation()
	if err != nil {
		return Target{Generation: generation}, nil
	}
	state := transport.options.Bridge.Snapshot()
	if refresh && transport.options.Bridge.Status() == contracts.ConnectionStatusOnline {
		state, err = transport.options.Bridge.Refresh(ctx)
		if err != nil {
			return Target{}, err
		}
	}

	if !transport.current(binding, generation) {
		return Target{}, ErrConnectionChanged
	}
	var capabilities struct {
		Backups bool `json:"backups"`
	}
	_ = json.Unmarshal(state.Extra["capabilities"], &capabilities)
	return Target{
		Identity:   computer.BindingRecordDigest(binding),
		Generation: generation,
		Online:     transport.options.Bridge.Status() == contracts.ConnectionStatusOnline,
		Supported:  capabilities.Backups,
		Version:    transport.options.Version(),
	}, nil
}

func (transport *VMTransport) Export(ctx context.Context) (ExportSource, error) {
	response, err := transport.options.Bridge.Request(ctx, http.MethodGet, "/api/backups/export", nil, nil)
	if err != nil {
		return ExportSource{}, err
	}

	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		if response.StatusCode == http.StatusConflict {
			return ExportSource{}, ErrBusy
		}
		if response.StatusCode == http.StatusNotFound {
			return ExportSource{}, ErrServiceUpdate
		}
		return ExportSource{}, ErrInvalid
	}
	encoded := response.Header.Get("X-Dant-Backup-Metadata")
	if len(encoded) == 0 || len(encoded) > 4096 {
		response.Body.Close()
		return ExportSource{}, ErrInvalid
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(raw) != encoded {
		response.Body.Close()
		return ExportSource{}, ErrInvalid
	}

	if _, err := contracts.DecodeObject(raw, 4096); err != nil {
		response.Body.Close()
		return ExportSource{}, ErrInvalid
	}
	var metadata Metadata
	if json.Unmarshal(raw, &metadata) != nil {
		response.Body.Close()
		return ExportSource{}, ErrInvalid
	}
	validated := metadata
	validated.ID = NewID()
	validated.Source = "000000000000"
	if !validated.Valid() {
		response.Body.Close()
		return ExportSource{}, ErrInvalid
	}

	return ExportSource{Metadata: metadata, Stream: response.Body}, nil
}

func (transport *VMTransport) ssh(ctx context.Context, binding computer.Binding, command string, input io.Reader) ([]byte, error) {
	bounded, stop := context.WithTimeout(ctx, BackupIOTimeout)
	defer stop()
	args := append(computer.SSHArgs(binding), binding.User+"@"+binding.Host, command)
	raw, err := transport.options.Run(bounded, "ssh", args, input)
	if err != nil || len(raw) > 4096 {
		return nil, ErrRestoreUnconfirmed
	}

	if _, err := contracts.DecodeObject(raw, 4096); err != nil {
		return nil, ErrRestoreUnconfirmed
	}

	return raw, nil
}

func backupGoCommand(action, id string) string {
	return `"$HOME/dant/bin/dant-core" --role=backup-cli ` + action + ` --data-dir "$HOME/dant/data" --workspace-root "$HOME/dant/workspaces" --restore-id ` + id
}

func (transport *VMTransport) Restore(ctx context.Context, input io.Reader, id string, target Target) error {
	if !backupID.MatchString(id) {
		return ErrInvalid
	}
	binding, err := transport.options.Binding()
	if err != nil || computer.BindingRecordDigest(binding) != target.Identity || !transport.current(binding, target.Generation) {
		return ErrConnectionChanged
	}

	if err := transport.options.Bridge.PauseWorkForUpdate(ctx, "install"); err != nil {
		return err
	}
	state, err := transport.options.Bridge.Refresh(ctx)
	if err != nil || !computer.ServiceUpdateQuiescent(state, true) || !transport.current(binding, target.Generation) {
		return ErrBusy
	}
	command := "set -eu\ntest -x \"$HOME/dant/bin/dant-core\"\nsystemctl --user stop dant-worker.service\n" + backupGoCommand("restore", id) + " >/dev/null\n" + backupGoCommand("finish", id)
	raw, err := transport.ssh(ctx, binding, command, input)
	if err != nil {
		return err
	}
	var receipt RestoreReceipt
	if json.Unmarshal(raw, &receipt) != nil || !receipt.Restored || receipt.RestoreID != id || !transport.current(binding, target.Generation) {
		return ErrRestoreUnconfirmed
	}

	return transport.options.Bridge.Connect(ctx, false)
}

func (transport *VMTransport) loaded(ctx context.Context, binding computer.Binding, id string) bool {
	generation := transport.options.Bridge.Generation()
	if transport.options.Bridge.Status() != contracts.ConnectionStatusOnline {
		return false
	}
	response, err := transport.options.Bridge.Request(ctx, http.MethodGet, "/api/backups/info", nil, nil)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	var receipt RestoreReceipt
	return err == nil && len(raw) <= 4096 && response.StatusCode == http.StatusOK && json.Unmarshal(raw, &receipt) == nil && receipt.Restored && receipt.RestoreID == id && transport.current(binding, generation)
}

func (transport *VMTransport) Reconcile(ctx context.Context, id string, target Target) (bool, error) {
	if !backupID.MatchString(id) {
		return false, ErrInvalid
	}
	binding, err := transport.options.Binding()
	if err != nil || computer.BindingRecordDigest(binding) != target.Identity {
		return false, ErrConnectionChanged
	}
	bounded, stop := context.WithTimeout(ctx, 30*time.Second)
	defer stop()
	if transport.loaded(bounded, binding, id) {
		return true, nil
	}
	generation := transport.options.Bridge.Generation()
	raw, err := transport.ssh(bounded, binding, "set -eu\n"+backupGoCommand("finish", id), nil)
	if err != nil {
		return false, err
	}
	var receipt RestoreReceipt
	if json.Unmarshal(raw, &receipt) != nil || !receipt.Restored || receipt.RestoreID != id || !transport.current(binding, generation) {
		return false, ErrRestoreUnconfirmed
	}

	if err := transport.options.Bridge.Connect(bounded, false); err != nil {
		return false, err
	}

	return transport.loaded(bounded, binding, id), nil
}

func (transport *VMTransport) Rejected(ctx context.Context, id string, target Target) (bool, error) {
	if !backupID.MatchString(id) {
		return false, ErrInvalid
	}
	binding, err := transport.options.Binding()
	generation := transport.options.Bridge.Generation()
	if err != nil || computer.BindingRecordDigest(binding) != target.Identity {
		return false, ErrConnectionChanged
	}
	bounded, stop := context.WithTimeout(ctx, 30*time.Second)
	defer stop()
	raw, err := transport.ssh(bounded, binding, "set -eu\n"+backupGoCommand("outcome", id), nil)
	if err != nil {
		return false, err
	}
	var receipt RestoreRejection
	if json.Unmarshal(raw, &receipt) != nil || receipt.RestoreID != id || !transport.current(binding, generation) {
		return false, ErrRestoreUnconfirmed
	}

	return receipt.Rejected, nil
}

var _ BackupTransport = (*VMTransport)(nil)
