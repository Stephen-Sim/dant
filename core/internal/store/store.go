// Package store owns durable conversation state. Public snapshots are copies;
// execution owners hold exact identities rather than mutable message pointers.
package store

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const MaxStateBytes = 128 * 1024 * 1024
const stateFileName = "state.json"

var (
	ErrInvalidState    = errors.New("conversation_state_invalid")
	ErrPersistence     = errors.New("conversation_state_save_failed")
	ErrMessageNotFound = errors.New("message_not_found")
	ErrMessageConflict = errors.New("message_identity_conflict")
	ErrClosed          = errors.New("conversation_store_closed")
	ErrNoChange        = errors.New("conversation_no_change")
)

type Options struct {
	Now   func() time.Time
	NewID func() string
	Write func(context.Context, string, []byte, fs.FileMode) error
}
type Store struct {
	mu          sync.RWMutex
	dir, file   string
	state       contracts.State
	now         func() time.Time
	newID       func() string
	write       func(context.Context, string, []byte, fs.FileMode) error
	closed      bool
	revision    uint64
	subscribers map[chan struct{}]struct{}
}

// Every writer in this process shares the state-file transaction boundary.
// The Worker process is the sole runtime owner; scheduler database admission
// additionally fences cross-process scheduled-message materialization.
var persistenceGate = make(chan struct{}, 1)

func UUID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("secure identity source unavailable")
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[:4], value[4:6], value[6:8], value[8:10], value[10:])
}

func Open(directory string, options Options) (*Store, error) {
	return OpenContext(context.Background(), directory, options)
}

func OpenContext(ctx context.Context, directory string, options Options) (*Store, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return nil, ErrInvalidState
	}
	if _, err = files.OrdinaryDirectory(absolute, true); err != nil {
		return nil, ErrPersistence
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.NewID == nil {
		options.NewID = UUID
	}
	if options.Write == nil {
		options.Write = files.WriteAtomic
	}
	value := &Store{dir: absolute, file: filepath.Join(absolute, stateFileName), now: options.Now, newID: options.NewID, write: options.Write, subscribers: make(map[chan struct{}]struct{})}
	select {
	case persistenceGate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() {
		<-persistenceGate
	}()
	raw, err := files.ReadRegular(value.file, MaxStateBytes)
	if errors.Is(err, fs.ErrNotExist) {
		raw = []byte(`{}`)
	} else if err != nil {
		return nil, ErrPersistence
	}
	value.state, err = restore(raw, value.newID, true)
	if err != nil {
		return nil, err
	}
	if err = value.persist(ctx, value.state); err != nil {
		return nil, err
	}
	return value, nil
}

func (value *Store) Directory() string {
	return value.dir
}

func (value *Store) ConversationID() string {
	value.mu.RLock()
	defer value.mu.RUnlock()
	return value.state.ConversationID
}

func (value *Store) Revision() uint64 {
	value.mu.RLock()
	defer value.mu.RUnlock()
	return value.revision
}

func clone(state contracts.State) (contracts.State, error) {
	raw, err := json.Marshal(state)
	if err != nil {
		return contracts.State{}, ErrInvalidState
	}
	var result contracts.State
	if json.Unmarshal(raw, &result) != nil {
		return contracts.State{}, ErrInvalidState
	}
	return result, nil
}

func (value *Store) Snapshot() contracts.State {
	value.mu.RLock()
	defer value.mu.RUnlock()
	state, err := clone(value.state)
	if err != nil {
		panic("validated conversation snapshot failed")
	}
	return state
}

func (value *Store) Subscribe() (
	<-chan struct{},
	func()) {
	value.mu.Lock()
	defer value.mu.Unlock()
	channel := make(chan struct{}, 1)
	if value.closed {
		close(channel)
		return channel, func() {}
	}
	value.subscribers[channel] = struct{}{}
	var once sync.Once
	return channel, func() {
		once.Do(func() {
			value.mu.Lock()
			defer value.mu.Unlock()
			if _, exists := value.subscribers[channel]; exists {
				delete(value.subscribers, channel)
				close(channel)
			}
		})
	}
}

func (value *Store) Close() {
	value.mu.Lock()
	defer value.mu.Unlock()
	if value.closed {
		return
	}
	value.closed = true
	for channel := range value.subscribers {
		close(channel)
		delete(value.subscribers, channel)
	}
}

func (value *Store) persist(ctx context.Context, state contracts.State) error {
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil || len(raw) > MaxStateBytes {
		return ErrInvalidState
	}
	if err = value.write(ctx, value.file, raw, 0o600); err != nil {
		return ErrPersistence
	}
	return nil
}

// Mutate commits only after a durable atomic write succeeds. No caller receives
// a live state pointer, and failures cannot leak partial in-memory changes.
func (value *Store) Mutate(
	ctx context.Context,
	change func(*contracts.State) error) error {
	if change == nil {
		return ErrInvalidState
	}
	select {
	case persistenceGate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() {
		<-persistenceGate
	}()
	value.mu.RLock()
	closed := value.closed
	value.mu.RUnlock()
	if closed {
		return ErrClosed
	}
	raw, err := files.ReadRegular(value.file, MaxStateBytes)
	if err != nil {
		return ErrPersistence
	}
	state, err := restore(raw, value.newID, false)
	if err != nil {
		return err
	}
	if err = change(&state); err != nil {
		if errors.Is(err, ErrNoChange) {
			copied, cloneErr := clone(state)
			if cloneErr != nil {
				return cloneErr
			}
			value.mu.Lock()
			value.state = copied
			value.mu.Unlock()
			return nil
		}
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	committed, err := clone(state)
	if err != nil {
		return err
	}
	if err = value.persist(ctx, committed); err != nil {
		return err
	}
	value.mu.Lock()
	defer value.mu.Unlock()
	value.state = committed
	value.revision++
	for channel := range value.subscribers {
		select {
		case channel <- struct{}{}:
		default:
		}
	}
	return nil
}

func (value *Store) Timestamp() float64 {
	return float64(value.now().UnixMilli())
}
