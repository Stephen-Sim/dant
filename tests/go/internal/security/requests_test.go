package security

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"testing/synctest"
)

func TestCredentialFormsDeduplicateAndNeverRevealSecretInSnapshots(t *testing.T) {
	synctest.Test(t, testCredentialFormsDeduplicate)
}

func testCredentialFormsDeduplicate(t *testing.T) {
	vault, err := NewVault(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	changes := make(chan struct{}, 8)
	requests := NewCredentialRequests(vault, func() {
		select {
		case changes <- struct{}{}:
		default:
		}
	})
	defer requests.Close()
	results := make(chan error, 2)
	for index := 0; index < 2; index++ {
		go func() {
			result, err := requests.Request(context.Background(), RequestInput{Name: "Fixture", Service: "site"}, "turn-fixture", func() bool { return true })
			if err == nil && !result.Stored {
				err = ErrCredentialInactive
			}
			results <- err
		}()
	}
	synctest.Wait()
	<-changes
	snapshot := requests.Snapshot(context.Background())
	if len(snapshot.Requests) != 1 {
		t.Fatal("duplicate secure form created")
	}
	result, err := requests.Fulfill(context.Background(), snapshot.Requests[0].ID, CredentialInput{Username: stringPointer("fixture-user"), Secret: stringPointer("fixture-password-value")})
	if err != nil || !result.Stored {
		t.Fatal("secure form failed to save")
	}
	for index := 0; index < 2; index++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	encoded, err := json.Marshal(requests.Snapshot(context.Background()))
	if err != nil || bytes.Contains(encoded, []byte("fixture-password-value")) {
		t.Fatal("credential secret leaked through snapshot")
	}
	var snapshotObject map[string]json.RawMessage
	if json.Unmarshal(encoded, &snapshotObject) != nil || len(requests.Snapshot(context.Background()).Requests) != 0 {
		t.Fatal("completed form remained pending")
	}
	entries, err := vault.List(context.Background())
	if err != nil || len(entries) != 1 {
		t.Fatal("credential stored more than once")
	}
}

func TestCredentialOwnerCancellationCannotSaveOrResolveStaleForm(t *testing.T) {
	vault, err := NewVault(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	changed := make(chan struct{}, 4)
	requests := NewCredentialRequests(vault, func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	})
	defer requests.Close()
	var current atomic.Bool
	current.Store(true)
	finished := make(chan error, 1)
	go func() {
		_, err := requests.Request(context.Background(), RequestInput{Name: "Fixture"}, "old-turn", current.Load)
		finished <- err
	}()
	<-changed
	snapshot := requests.Snapshot(context.Background())
	current.Store(false)
	if _, err := requests.Fulfill(context.Background(), snapshot.Requests[0].ID, CredentialInput{Secret: stringPointer("fixture-secret")}); !errors.Is(err, ErrCredentialInactive) {
		t.Fatal("stale owner received credentials")
	}
	if err := <-finished; !errors.Is(err, ErrCredentialCancelled) {
		t.Fatal("cancelled owner did not stop waiting")
	}
	entries, err := vault.List(context.Background())
	if err != nil || len(entries) != 0 {
		t.Fatal("stale form persisted input")
	}
	for _, raw := range []string{`{"id":null,"name":"Fixture","secret":"value"}`, `{"id":"\ud800"}`, `{"secret":"\ud800"}`} {
		var input CredentialInput
		if json.Unmarshal([]byte(raw), &input) == nil {
			t.Fatal("ambiguous credential identity/text accepted")
		}
	}
}
