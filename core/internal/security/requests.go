package security

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/google/uuid"
)

const (
	PendingCredentialLimit   = 10
	CredentialRequestTimeout = 10 * time.Minute
)

var (
	ErrCredentialInactive     = errors.New("credential_request_inactive")
	ErrCredentialCancelled    = errors.New("credential_request_cancelled")
	ErrCredentialRequestLimit = errors.New("credential_request_limit")
)

// CredentialRepository exposes only the capabilities consumed by secure forms.
type CredentialRepository interface {
	List(context.Context) ([]CredentialMetadata, error)
	Find(context.Context, string) ([]CredentialMetadata, error)
	Get(context.Context, string) (Credential, error)
	Upsert(context.Context, CredentialInput) (CredentialMetadata, error)
	Remove(context.Context, string) (RemovedCredential, error)
	ContainsSecret(context.Context, string) (bool, error)
	Redact(context.Context, string, bool, []string) (string, error)
}

type RequestInput struct {
	Name    string `json:"name"`
	Service string `json:"service"`
	Reason  string `json:"reason"`
}

type RequestInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Service string `json:"service"`
	Reason  string `json:"reason"`
}

type CredentialResult struct {
	Stored     bool               `json:"stored"`
	Credential CredentialMetadata `json:"credential"`
}

type CredentialSnapshot struct {
	Items    []CredentialMetadata `json:"items"`
	Requests []RequestInfo        `json:"requests"`
	Error    *string              `json:"error,omitempty"`
}

type CancelledCredentialRequest struct {
	Cancelled bool `json:"cancelled"`
}

type credentialFuture struct {
	info        RequestInfo
	owner       string
	current     func() bool
	done        chan struct{}
	result      CredentialResult
	err         error
	timer       *time.Timer
	stopContext func() bool
	fulfilling  bool
}

type CredentialRequests struct {
	mu      sync.Mutex
	vault   CredentialRepository
	change  func()
	timeout time.Duration
	pending map[string]*credentialFuture
	order   []string
	closed  bool
}

func NewCredentialRequests(vault CredentialRepository, change func()) *CredentialRequests {
	if change == nil {
		change = func() {}
	}
	return &CredentialRequests{vault: vault, change: change, timeout: CredentialRequestTimeout, pending: make(map[string]*credentialFuture)}
}

func (requests *CredentialRequests) Snapshot(ctx context.Context) CredentialSnapshot {
	requests.mu.Lock()
	items := make([]RequestInfo, 0, len(requests.pending))
	for _, id := range requests.order {
		if pending := requests.pending[id]; pending != nil {
			items = append(items, pending.info)
		}
	}
	requests.mu.Unlock()
	result := CredentialSnapshot{Items: []CredentialMetadata{}, Requests: items}
	entries, err := requests.vault.List(ctx)
	if err != nil {
		message := "Credential storage cannot be unlocked. Existing data was preserved."
		result.Error = &message
	} else {
		result.Items = entries
	}
	return result
}

func (requests *CredentialRequests) Find(ctx context.Context, query string) ([]CredentialMetadata, error) {
	return requests.vault.Find(ctx, query)
}

func (requests *CredentialRequests) Get(ctx context.Context, id string) (Credential, error) {
	return requests.vault.Get(ctx, id)
}

func (requests *CredentialRequests) ContainsSecret(ctx context.Context, text string) (bool, error) {
	return requests.vault.ContainsSecret(ctx, text)
}

func (requests *CredentialRequests) Redact(ctx context.Context, text string, partial bool, additional []string) (string, error) {
	return requests.vault.Redact(ctx, text, partial, additional)
}

func (requests *CredentialRequests) Upsert(ctx context.Context, input CredentialInput) (CredentialMetadata, error) {
	result, err := requests.vault.Upsert(ctx, input)
	if err == nil {
		requests.change()
	}
	return result, err
}

func (requests *CredentialRequests) Remove(ctx context.Context, id string) (RemovedCredential, error) {
	result, err := requests.vault.Remove(ctx, id)
	if err == nil {
		requests.change()
	}
	return result, err
}

func (requests *CredentialRequests) Request(ctx context.Context, input RequestInput, owner string, isCurrent func() bool) (CredentialResult, error) {
	if err := ctx.Err(); err != nil {
		return CredentialResult{}, err
	}
	if owner == "" || isCurrent == nil || !isCurrent() {
		return CredentialResult{}, ErrCredentialInactive
	}
	if !validCredentialField(input.Name, 100, true) || !validCredentialField(input.Service, 200, false) || !validCredentialField(input.Reason, 500, false) {
		return CredentialResult{}, ErrCredential
	}
	input.Name = contracts.TrimText(input.Name)
	input.Service = contracts.TrimText(input.Service)
	requests.mu.Lock()
	if requests.closed {
		requests.mu.Unlock()
		return CredentialResult{}, ErrCredentialInactive
	}
	var future *credentialFuture
	for _, id := range requests.order {
		if existing := requests.pending[id]; existing != nil && existing.owner == owner &&
			existing.info.Name == input.Name && existing.info.Service == input.Service {
			future = existing
			break
		}
	}
	created := false
	if future == nil {
		if len(requests.pending) >= PendingCredentialLimit {
			requests.mu.Unlock()
			return CredentialResult{}, ErrCredentialRequestLimit
		}
		id, err := uuid.NewRandom()
		if err != nil {
			requests.mu.Unlock()
			return CredentialResult{}, ErrCredentialInactive
		}
		future = &credentialFuture{
			info: RequestInfo{
				ID:      id.String(),
				Name:    input.Name,
				Service: input.Service,
				Reason:  input.Reason,
			},
			owner:   owner,
			current: isCurrent,
			done:    make(chan struct{}),
		}
		requests.pending[future.info.ID] = future
		requests.order = append(requests.order, future.info.ID)
		future.timer = time.AfterFunc(requests.timeout, func() { _, _ = requests.Cancel(future.info.ID) })
		future.stopContext = context.AfterFunc(ctx, func() { _, _ = requests.Cancel(future.info.ID) })
		created = true
	}
	requests.mu.Unlock()
	if created {
		requests.change()
	}
	select {
	case <-ctx.Done():
		return CredentialResult{}, ctx.Err()
	case <-future.done:
		return future.result, future.err
	}
}

func (requests *CredentialRequests) finishLocked(future *credentialFuture, result CredentialResult, err error) bool {
	if requests.pending[future.info.ID] != future {
		return false
	}
	delete(requests.pending, future.info.ID)
	for index, id := range requests.order {
		if id == future.info.ID {
			requests.order = append(requests.order[:index], requests.order[index+1:]...)
			break
		}
	}
	if future.timer != nil {
		future.timer.Stop()
	}
	if future.stopContext != nil {
		future.stopContext()
	}
	future.result, future.err = result, err
	close(future.done)
	return true
}

func (requests *CredentialRequests) Fulfill(ctx context.Context, id string, input CredentialInput) (CredentialResult, error) {
	requests.mu.Lock()
	future := requests.pending[id]
	if future == nil || future.fulfilling {
		requests.mu.Unlock()
		return CredentialResult{}, ErrCredentialInactive
	}
	future.fulfilling = true
	requests.mu.Unlock()
	defer func() {
		requests.mu.Lock()
		if requests.pending[id] == future {
			future.fulfilling = false
		}
		requests.mu.Unlock()
	}()
	if !future.current() {
		_, _ = requests.Cancel(id)
		return CredentialResult{}, ErrCredentialInactive
	}
	username := ""
	if input.Username != nil {
		username = *input.Username
	}
	if input.Secret == nil || !validCredentialField(username, 300, false) || !validCredentialField(*input.Secret, 16384, true) {
		return CredentialResult{}, ErrCredential
	}
	entries, err := requests.vault.List(ctx)
	if err != nil {
		return CredentialResult{}, err
	}
	write := CredentialInput{Name: &future.info.Name, Service: &future.info.Service, Username: &username, Secret: input.Secret}
	for _, entry := range entries {
		if entry.Name == future.info.Name && entry.Service == future.info.Service && entry.Username == username {
			id := entry.ID
			write.ID = &id
			break
		}
	}
	metadata, err := requests.vault.Upsert(ctx, write)
	if err != nil {
		return CredentialResult{}, err
	}
	// Saving is the user's explicit form action. A cancelled execution may not
	// receive the saved credential as a late tool receipt.
	current := future.current()
	requests.mu.Lock()
	result := CredentialResult{Stored: true, Credential: metadata}
	if !current || requests.pending[id] != future {
		requests.mu.Unlock()
		requests.change()
		return CredentialResult{}, ErrCredentialInactive
	}
	requests.finishLocked(future, result, nil)
	requests.mu.Unlock()
	requests.change()
	return result, nil
}

func (requests *CredentialRequests) Cancel(id string) (CancelledCredentialRequest, error) {
	requests.mu.Lock()
	future := requests.pending[id]
	if future == nil {
		requests.mu.Unlock()
		return CancelledCredentialRequest{}, ErrCredentialInactive
	}
	requests.finishLocked(future, CredentialResult{}, ErrCredentialCancelled)
	requests.mu.Unlock()
	requests.change()
	return CancelledCredentialRequest{Cancelled: true}, nil
}

func (requests *CredentialRequests) CancelOwner(owner string) {
	requests.mu.Lock()
	changed := false
	for _, future := range requests.pending {
		if future.owner == owner {
			if requests.finishLocked(future, CredentialResult{}, ErrCredentialCancelled) {
				changed = true
			}
		}
	}
	requests.mu.Unlock()
	if changed {
		requests.change()
	}
}

func (requests *CredentialRequests) Close() {
	requests.mu.Lock()
	requests.closed = true
	changed := len(requests.pending) > 0
	for _, future := range requests.pending {
		requests.finishLocked(future, CredentialResult{}, ErrCredentialCancelled)
	}
	requests.mu.Unlock()
	if changed {
		requests.change()
	}
}
