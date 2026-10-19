package updates

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const InstallLeaseTTL = 30 * time.Second
const DesktopTransitionTimeout = 150 * time.Second

var ErrInstallationDeferred = errors.New("update_installation_deferred")

type InstallationSnapshot struct {
	Mode                string
	Authority           string
	VMConfigured        bool
	ControllerStatus    contracts.ConnectionStatus
	Cached              bool
	ProvisioningRunning bool
	ProvisioningStatus  contracts.ProvisioningStatus
	Worker              contracts.WorkerSnapshot
}

func InstallStateSafe(state InstallationSnapshot) bool {
	if state.Mode != "vm-controller" || state.Authority != "vm" || state.ProvisioningRunning {
		return false
	}
	switch state.ProvisioningStatus {
	case contracts.ProvisioningStatusIdle, contracts.ProvisioningStatusReady, contracts.ProvisioningStatusFailed:
	default:
		return false
	}

	if !state.VMConfigured {
		return state.Worker.Active == nil && state.Worker.Call == nil && state.Worker.Queue != nil && len(state.Worker.Queue) == 0 && !state.Worker.Takeover && !state.Worker.Acquiring
	}

	return state.ControllerStatus == contracts.ConnectionStatusOnline && !state.Cached && computer.ServiceUpdateQuiescent(state.Worker, true)
}

func UpdateSensitiveRequest(method, originalURL string) (bool, error) {
	if originalURL == "" {
		return false, ErrInstallationDeferred
	}
	parsed, err := url.ParseRequestURI(originalURL)
	if err != nil {
		return false, ErrInstallationDeferred
	}
	path, err := url.PathUnescape(parsed.EscapedPath())
	if err != nil {
		return false, ErrInstallationDeferred
	}
	path = strings.TrimRight(strings.ToLower(path), "/")
	if method != "POST" && method != "PATCH" && method != "DELETE" {
		return false, nil
	}

	return strings.HasPrefix(path, "/api/") && !strings.HasPrefix(path, "/api/desktop/") && path != "/api/updates" && !strings.HasPrefix(path, "/api/updates/"), nil
}

type LeaseReceipt struct {
	LeaseID   string `json:"leaseId"`
	ExpiresAt int64  `json:"expiresAt"`
}

type LeaseOptions struct {
	Snapshot  func() InstallationSnapshot
	Refresh   func(context.Context) error
	OnFailure func()
	OnRelease func()
	Now       func() time.Time
	TTL       time.Duration
	ID        func() string
}

type InstallLease struct {
	mu        sync.Mutex
	options   LeaseOptions
	pending   int
	checking  bool
	uncertain bool
	closed    bool
	lease     *LeaseReceipt
	wake      chan struct{}
	stop      chan struct{}
	done      chan struct{}
}

func newID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic("host entropy unavailable")
	}
	bytes[6] = bytes[6]&0x0f | 0x40
	bytes[8] = bytes[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}

func NewInstallLease(options LeaseOptions) *InstallLease {
	if options.Now == nil {
		options.Now = time.Now
	}

	if options.TTL <= 0 {
		options.TTL = InstallLeaseTTL
	}

	if options.ID == nil {
		options.ID = newID
	}

	if options.OnFailure == nil {
		options.OnFailure = func() {}
	}

	if options.OnRelease == nil {
		options.OnRelease = func() {}
	}

	if options.Refresh == nil {
		options.Refresh = func(context.Context) error { return ErrInstallationDeferred }
	}

	if options.Snapshot == nil {
		options.Snapshot = func() InstallationSnapshot { return InstallationSnapshot{} }
	}
	lease := &InstallLease{options: options, wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{})}
	go lease.expirations()
	return lease
}

func (lease *InstallLease) notify() {
	select {
	case lease.wake <- struct{}{}:
	default:
	}
}

func (lease *InstallLease) expireLocked() bool {
	if lease.lease != nil && lease.lease.ExpiresAt <= lease.options.Now().UnixMilli() {
		lease.lease = nil
		return true
	}

	return false
}

func (lease *InstallLease) expirations() {
	defer close(lease.done)
	for {
		lease.mu.Lock()
		var expiry int64
		if lease.lease != nil {
			expiry = lease.lease.ExpiresAt
		}
		now := lease.options.Now().UnixMilli()
		lease.mu.Unlock()
		var timer *time.Timer
		var expired <-chan time.Time
		if expiry != 0 {
			delay := time.Duration(expiry-now) * time.Millisecond
			if delay < time.Millisecond {
				delay = time.Millisecond
			}
			timer = time.NewTimer(delay)
			expired = timer.C
		}
		select {
		case <-lease.stop:
			if timer != nil {
				timer.Stop()
			}
			return
		case <-lease.wake:
			if timer != nil {
				timer.Stop()
			}
		case <-expired:
			lease.mu.Lock()
			released := !lease.closed && lease.expireLocked()
			lease.mu.Unlock()
			if released {
				lease.options.OnRelease()
			}
		}
	}
}

func (lease *InstallLease) Current() *LeaseReceipt {
	lease.mu.Lock()
	released := lease.expireLocked()
	var result *LeaseReceipt
	if lease.lease != nil {
		copy := *lease.lease
		result = &copy
	}
	lease.mu.Unlock()
	if released {
		lease.options.OnRelease()
		lease.notify()
	}

	return result
}

func (lease *InstallLease) AssertQuiescent(allowPending int) error {
	lease.Current()
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.closed || lease.checking || lease.lease != nil || lease.pending > allowPending || lease.uncertain {
		return ErrInstallationDeferred
	}

	return nil
}

func (lease *InstallLease) Enter() (func(bool), error) {
	lease.Current()
	lease.mu.Lock()
	if lease.closed || lease.checking || lease.lease != nil {
		lease.mu.Unlock()
		return nil, ErrInstallationDeferred
	}
	lease.pending++
	lease.mu.Unlock()
	var once sync.Once
	return func(unknown bool) {
		once.Do(func() {
			lease.mu.Lock()
			lease.pending--
			lease.uncertain = lease.uncertain || unknown
			lease.mu.Unlock()
		})
	}, nil
}

func (lease *InstallLease) Acquire(ctx context.Context) (LeaseReceipt, error) {
	lease.Current()
	lease.mu.Lock()
	if lease.closed || lease.checking || lease.lease != nil || lease.pending > 0 || lease.uncertain {
		lease.mu.Unlock()
		return LeaseReceipt{}, ErrInstallationDeferred
	}
	lease.checking = true
	lease.mu.Unlock()
	err := lease.options.Refresh(ctx)
	observation := lease.options.Snapshot()
	lease.mu.Lock()
	safe := err == nil && !lease.closed && lease.pending == 0 && !lease.uncertain && ctx.Err() == nil && InstallStateSafe(observation)
	lease.checking = false
	if !safe {
		lease.mu.Unlock()
		lease.options.OnFailure()
		return LeaseReceipt{}, ErrInstallationDeferred
	}
	receipt := LeaseReceipt{LeaseID: lease.options.ID(), ExpiresAt: lease.options.Now().Add(lease.options.TTL).UnixMilli()}
	lease.lease = &receipt
	lease.mu.Unlock()
	lease.notify()
	return receipt, nil
}

func (lease *InstallLease) change(id string, duration time.Duration) (LeaseReceipt, error) {
	lease.Current()
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.closed || lease.lease == nil || lease.lease.LeaseID != id {
		return LeaseReceipt{}, ErrInstallationDeferred
	}
	lease.lease.ExpiresAt = lease.options.Now().Add(duration).UnixMilli()
	lease.notify()
	return *lease.lease, nil
}

func (lease *InstallLease) Pin(id string) (LeaseReceipt, error) {
	return lease.change(id, DesktopTransitionTimeout)
}

func (lease *InstallLease) Renew(id string) (LeaseReceipt, error) {
	return lease.change(id, lease.options.TTL)
}

func (lease *InstallLease) Release(id string) error {
	lease.Current()
	lease.mu.Lock()
	if lease.closed || lease.lease == nil || lease.lease.LeaseID != id {
		lease.mu.Unlock()
		return ErrInstallationDeferred
	}
	lease.lease = nil
	lease.mu.Unlock()
	lease.options.OnRelease()
	lease.notify()
	return nil
}

func (lease *InstallLease) Close() {
	lease.mu.Lock()
	if lease.closed {
		lease.mu.Unlock()
		<-lease.done
		return
	}
	lease.closed = true
	lease.lease = nil
	close(lease.stop)
	lease.mu.Unlock()
	<-lease.done
}
