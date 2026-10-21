package voice

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAPIClosureCannotClaimJoinedWhenAnOwnedWorkerHasNotReturned(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		api, session, _ := eventOnlyAPIFixture(t)
		release := make(chan struct{})
		session.workers.Add(1)
		go func() { defer session.workers.Done(); <-release }()
		if err := api.Close(t.Context()); !errors.Is(err, ErrVoiceHangup) || api.Snapshot().Call != nil {
			t.Fatal("unjoined sideband worker was reported as confirmed media cleanup", err)
		}
		close(release)
		synctest.Wait()
		if err := api.Close(t.Context()); !errors.Is(err, ErrVoiceHangup) {
			t.Fatal("unconfirmed cleanup was silently rewritten into a successful receipt", err)
		}
	})
}

func TestAPIClosureRetainsUnknownContextUntilItsActualSendOwnerReturns(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		api, session, _ := eventOnlyAPIFixture(t)
		entered, release := make(chan struct{}), make(chan struct{})
		queue, err := NewContextQueue(t.Context(), ContextQueueOptions{CallID: session.callID, IsCurrent: func() bool { return true }, Send: func(context.Context, ContextInput) error {
			close(entered)
			<-release
			return ErrContextUnknown
		}})
		if err != nil {
			t.Fatal(err)
		}
		session.contextQueue = queue
		done := make(chan ContextResult, 1)
		go func() {
			done <- queue.Enqueue(t.Context(), ContextInput{Key: "memory", Kind: "memory", Text: "Synthetic pending context"})
		}()
		<-entered
		closeErr := api.Close(t.Context())
		close(release)
		if result := <-done; result.Status == contracts.LiveContextStatusSubmitted {
			t.Fatal("unconfirmed context sender became submitted while shutting down")
		}
		if err := queue.Close(t.Context()); err != nil {
			t.Fatal("returned context sender did not join", err)
		}
		if !errors.Is(closeErr, ErrVoiceContext) && !errors.Is(closeErr, ErrVoiceHangup) {
			t.Fatal("context sender without a join receipt was reported confirmed", closeErr)
		}
	})
}

func TestAPIStartRechecksMediaOwnerAfterTheOfferResponse(t *testing.T) {
	api, _, _ := apiFixture(t, APIOptions{})
	client := api.options.HTTP
	api.options.HTTP = voiceHTTPFunc(func(request *http.Request) (*http.Response, error) {
		response, err := client.Do(request)
		if err == nil && !strings.HasSuffix(request.URL.Path, "/hangup") {
			api.mu.Lock()
			api.session.cancel()
			api.mu.Unlock()
		}
		return response, err
	})
	if _, err := api.Start(t.Context(), APIStart{SDP: fixtureSDP, CallID: "late-offer-call"}); !errors.Is(err, ErrVoiceCancelled) || api.Snapshot().Call != nil {
		t.Fatal("late offer response activated an ended media owner", err)
	}
	if err := api.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
}
