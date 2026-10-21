package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/work"
)

func holdWorkerConversation(t *testing.T, app *WorkerApp) func() {
	t.Helper()
	entered := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan error, 1)
	conversation := app.store.ConversationID()
	go func() {
		finished <- app.engine.ConversationTransaction(t.Context(), conversation, func(ctx context.Context) error {
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	var once sync.Once
	finish := func() {
		once.Do(func() {
			close(release)
			select {
			case err := <-finished:
				if err != nil {
					t.Error("isolated persistence boundary did not settle", err)
				}
			case <-time.After(5 * time.Second):
				t.Error("isolated persistence boundary retained its owner")
			}
		})
	}
	t.Cleanup(finish)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("isolated persistence boundary was not entered")
	}
	return finish
}

func TestWorkerCancelledMaintenanceWaitDoesNotLeaveAnIdleReservation(t *testing.T) {
	app := fixtureWorker(t)
	release := holdWorkerConversation(t, app)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if lease, err := app.reserveMaintenance(ctx); !errors.Is(err, context.Canceled) || lease != nil {
		t.Fatal("cancelled caller acquired maintenance while persistence was pending", err)
	}
	release()
	app.wg.Wait()
	if app.engine.MaintenanceActive() || app.maintenance != nil {
		t.Fatal("cancelled maintenance wait retained admission")
	}
	lease, err := app.reserveMaintenance(t.Context())
	if err != nil {
		t.Fatal("cancelled reservation prevented a later explicit admission", err)
	}
	lease.cancel()
	<-lease.done
}

func TestWorkerCallInputReturnsOwnerClosureWhilePersistenceIsPending(t *testing.T) {
	app := fixtureWorker(t)
	message, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleUser, Text: "retained unsent input", ClientMessageID: "isolated-pending-input"})
	if err != nil {
		t.Fatal(err)
	}
	release := holdWorkerConversation(t, app)
	app.cancel()
	err = app.submitCallMessage(t.Context(), app.store.ConversationID(), work.AdmissionReceipt{Message: message, CallID: "retired-call"})
	if !errors.Is(err, work.ErrClosed) {
		t.Fatal("closed Worker lifetime did not release the admitted HTTP waiter", err)
	}
	release()
	app.operations.Wait()
	saved, err := app.store.Message(message.ID)
	if err != nil || saved.VoiceCallID != "" || saved.Text != message.Text || saved.Submission.Present {
		t.Fatal("retired call delivery mutated its saved unsent input", err)
	}
}

func TestWorkerBackupRejectsUnavailableStagingBeforePublishingArchiveHeaders(t *testing.T) {
	app := fixtureWorker(t)
	occupied := filepath.Join(t.TempDir(), "occupied-staging")
	original := []byte("preserved ordinary staging obstruction")
	if err := os.WriteFile(occupied, original, 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(name, occupied)
	}
	before := app.store.Revision()
	response := callWorker(app, http.MethodGet, "/api/backups/export", "")
	requireWorkerStatus(t, response, http.StatusInternalServerError)
	if response.Header().Get("X-Dant-Backup-Metadata") != "" || response.Header().Get("Content-Type") == "application/x-dant-backup" || app.store.Revision() != before {
		t.Fatal("failed snapshot construction published success or changed its source")
	}
	after, err := os.ReadFile(occupied)
	if err != nil || string(after) != string(original) || app.engine.MaintenanceActive() {
		t.Fatal("failed staging replaced an unrelated file or retained maintenance", err)
	}
}
