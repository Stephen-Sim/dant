// Package ownership grants one Go service exclusive access to its data root.
// The installer verifies that every previous executor has stopped before entry;
// acquiring this lock alone cannot establish that another process has stopped.
package ownership

import (
	"context"
	"errors"
	"os"
	"sync"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

const lockName = ".dant-core-owner.lock"

var ErrBusy = errors.New("core_owner_already_running")
var ErrChanged = errors.New("core_owner_directory_changed")

type Lock struct {
	root   *files.ManagedRoot
	file   *os.File
	mu     sync.Mutex
	closed bool
}

func Acquire(ctx context.Context, directory string) (*Lock, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	root, err := files.OpenManagedRoot(directory, true)
	if err != nil {
		return nil, err
	}
	file, err := root.OpenLockFile(lockName)
	if err != nil {
		_ = root.Close()
		return nil, err
	}
	if err := tryLock(file); err != nil {
		_ = file.Close()
		_ = root.Close()
		return nil, ErrBusy
	}
	lock := &Lock{root: root, file: file}
	if ctx.Err() != nil || !lock.Current() {
		_ = lock.Close()
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return nil, ErrChanged
	}
	return lock, nil
}

func (lock *Lock) Current() bool {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	return !lock.closed && lock.root.Unchanged() && files.SingleLink(lock.file)
}

func (lock *Lock) Close() error {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if lock.closed {
		return nil
	}
	lock.closed = true
	return errors.Join(unlock(lock.file), lock.file.Close(), lock.root.Close())
}
