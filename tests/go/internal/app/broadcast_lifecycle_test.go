package app

import (
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func launchBroadcast(t *testing.T, app *WorkerApp) <-chan struct{} {
	t.Helper()
	finished := make(chan struct{})
	app.wg.Add(1)
	go func() {
		defer close(finished)
		app.broadcast()
	}()
	return finished
}

func TestWorkerBroadcastCoalescesPersistenceWakeAndExecutionSignalsAndJoinsEveryOwner(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		app, wire, owner := acknowledgedToolFixture(t)
		client, ok := app.events.subscribe(t.Context())
		if !ok {
			t.Fatal("isolated observer could not subscribe")
		}
		defer app.events.remove(client)
		finished := launchBroadcast(t, app)
		synctest.Wait()
		time.Sleep(stateCoalescing + time.Millisecond)
		synctest.Wait()
		if initial := <-client.states; !strings.Contains(string(initial), owner.ConversationID) {
			t.Fatal("initial publication lost its conversation")
		}

		if _, err := app.store.Add(t.Context(), &contracts.ChatMessage{Role: contracts.RoleAssistant, Text: "saved synthetic publication"}); err != nil {
			t.Fatal(err)
		}
		app.change()
		synctest.Wait()
		time.Sleep(stateCoalescing + time.Millisecond)
		synctest.Wait()
		if state := <-client.states; !strings.Contains(string(state), "saved synthetic publication") || len(client.states) != 0 {
			t.Fatal("coalesced state omitted the persisted message or grew an unbounded queue")
		}
		if err := wire.frame(contracts.RawObject{"method": encode("item/agentMessage/delta"), "params": encode(contracts.RawObject{
			"threadId": encode("app-fixture-thread"), "turnId": encode(owner.TurnID), "itemId": encode("fixture-stream-item"), "delta": encode("synthetic stream output"),
		})}); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		if signal := <-client.control; !strings.Contains(string(signal), `"type":"delta"`) || !strings.Contains(string(signal), "synthetic stream output") {
			t.Fatal("current executor signal was not forwarded")
		}
		app.store.Close()
		<-finished
	})
}

func TestWorkerBroadcastRejectsClosedEngineAndJoinsWhenEngineSignalsClose(t *testing.T) {
	for _, before := range []bool{true, false} {
		t.Run(map[bool]string{true: "closed-before-subscribe", false: "closed-after-subscribe"}[before], func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				app := fixtureWorker(t)
				if before {
					app.engine.Close()
				}
				finished := launchBroadcast(t, app)
				synctest.Wait()
				if !before {
					app.engine.Close()
				}
				<-finished
			})
		})
	}
}
