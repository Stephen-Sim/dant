package security

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type controlledCredentialRepository struct {
	*Vault
	list   func(context.Context) ([]CredentialMetadata, error)
	upsert func(context.Context, CredentialInput) (CredentialMetadata, error)
}

func (repository controlledCredentialRepository) List(ctx context.Context) ([]CredentialMetadata, error) {
	if repository.list != nil {
		return repository.list(ctx)
	}
	return repository.Vault.List(ctx)
}

func (repository controlledCredentialRepository) Upsert(ctx context.Context, input CredentialInput) (CredentialMetadata, error) {
	if repository.upsert != nil {
		return repository.upsert(ctx, input)
	}
	return repository.Vault.Upsert(ctx, input)
}

func TestCredentialFormReadAndWriteFailuresRetainThePendingUserAction(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		vault, _ := NewVault(t.TempDir())
		var failRead, failWrite atomic.Bool
		failRead.Store(true)
		syntheticCause := errors.New("private-fixture-error")
		repository := controlledCredentialRepository{
			Vault: vault,
			list: func(ctx context.Context) ([]CredentialMetadata, error) {
				if failRead.Load() {
					return nil, syntheticCause
				}
				return vault.List(ctx)
			},
			upsert: func(ctx context.Context, input CredentialInput) (CredentialMetadata, error) {
				if failWrite.Load() {
					return CredentialMetadata{}, syntheticCause
				}
				return vault.Upsert(ctx, input)
			},
		}
		requests := NewCredentialRequests(repository, nil)
		t.Cleanup(requests.Close)
		finished := make(chan error, 1)
		go func() {
			_, err := requests.Request(t.Context(), RequestInput{Name: "Synthetic"}, "owner", func() bool { return true })
			finished <- err
		}()
		synctest.Wait()
		snapshot := requests.Snapshot(t.Context())
		if snapshot.Error == nil || strings.Contains(*snapshot.Error, syntheticCause.Error()) || len(snapshot.Requests) != 1 {
			t.Fatal("a storage failure exposed its private cause or erased the pending form")
		}
		id := snapshot.Requests[0].ID
		for _, input := range []CredentialInput{{}, {Secret: stringPointer(" ")}, {Username: stringPointer("bad\x00name"), Secret: stringPointer("synthetic")}} {
			if _, err := requests.Fulfill(t.Context(), id, input); !errors.Is(err, ErrCredential) {
				t.Fatal("invalid secure form input was stored", err)
			}
		}
		input := CredentialInput{Secret: stringPointer("synthetic-secret")}
		if _, err := requests.Fulfill(t.Context(), id, input); !errors.Is(err, syntheticCause) {
			t.Fatal("a failed read acknowledged the user's save action", err)
		}
		failRead.Store(false)
		failWrite.Store(true)
		if _, err := requests.Fulfill(t.Context(), id, input); !errors.Is(err, syntheticCause) {
			t.Fatal("a failed write acknowledged the user's save action", err)
		}
		if len(requests.Snapshot(t.Context()).Requests) != 1 {
			t.Fatal("an uncommitted save removed the secure form")
		}
		failWrite.Store(false)
		if _, err := requests.Fulfill(t.Context(), id, input); err != nil {
			t.Fatal(err)
		}
		if err := <-finished; err != nil {
			t.Fatal(err)
		}
	})
}

func TestCancelledExecutionCannotReceiveALateExplicitCredentialSave(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		vault, _ := NewVault(t.TempDir())
		entered, release := make(chan struct{}), make(chan struct{})
		repository := controlledCredentialRepository{Vault: vault, upsert: func(ctx context.Context, input CredentialInput) (CredentialMetadata, error) {
			close(entered)
			<-release
			return vault.Upsert(ctx, input)
		}}
		requests := NewCredentialRequests(repository, nil)
		t.Cleanup(requests.Close)
		requestDone := make(chan error, 1)
		go func() {
			_, err := requests.Request(t.Context(), RequestInput{Name: "Synthetic"}, "cancelled-owner", func() bool { return true })
			requestDone <- err
		}()
		synctest.Wait()
		snapshot := requests.Snapshot(t.Context())
		if len(snapshot.Requests) != 1 {
			t.Fatal("secure form was not admitted")
		}
		id := snapshot.Requests[0].ID
		saveDone := make(chan error, 1)
		go func() {
			_, err := requests.Fulfill(t.Context(), id, CredentialInput{Secret: stringPointer("synthetic-explicit-save")})
			saveDone <- err
		}()
		<-entered
		if _, err := requests.Fulfill(t.Context(), id, CredentialInput{Secret: stringPointer("duplicate-input")}); !errors.Is(err, ErrCredentialInactive) {
			t.Fatal("concurrent secure form save was replayed", err)
		}
		requests.CancelOwner("cancelled-owner")
		if err := <-requestDone; !errors.Is(err, ErrCredentialCancelled) {
			t.Fatal("cancelled execution received a successful tool receipt", err)
		}
		close(release)
		if err := <-saveDone; !errors.Is(err, ErrCredentialInactive) {
			t.Fatal("late explicit save delivered credentials to an ended execution", err)
		}
		entries, err := vault.List(t.Context())
		if err != nil || len(entries) != 1 {
			t.Fatal("the user's explicit save was lost or duplicated", err)
		}
	})
}

func TestCredentialRequestExpiryContextCancellationAndCloseAlwaysReleaseWaiters(t *testing.T) {
	for _, end := range []string{"expiry", "context", "close"} {
		t.Run(end, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				vault, _ := NewVault(t.TempDir())
				requests := NewCredentialRequests(vault, nil)
				requests.timeout = time.Second
				t.Cleanup(requests.Close)
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				finished := make(chan error, 1)
				go func() {
					_, err := requests.Request(ctx, RequestInput{Name: "Synthetic"}, "owner", func() bool { return true })
					finished <- err
				}()
				synctest.Wait()
				switch end {
				case "context":
					cancel()
				case "close":
					requests.Close()
				}
				if err := <-finished; !errors.Is(err, ErrCredentialCancelled) && !errors.Is(err, context.Canceled) {
					t.Fatal("ended secure form retained a waiter or became successful", err)
				}
				synctest.Wait()
				if len(requests.Snapshot(t.Context()).Requests) != 0 {
					t.Fatal("ended secure form remained in the pending inventory")
				}
			})
		})
	}
}
