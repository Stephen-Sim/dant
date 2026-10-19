package telegram

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestForwardingPreferenceDoesNotInterruptAnInflightExternalDelivery(t *testing.T) {
	fixture := fixture(t)
	fixture.add(t, "assistant", "reply")
	fixture.flush(t)
	fixture.Now.Add(2)
	started, release := make(chan struct{}), make(chan struct{})
	fixture.Send = func(request *http.Request) (*http.Response, error) {
		close(started)
		select {
		case <-release:
			return reply(200, `{"ok":true,"result":{"message_id":50}}`), nil
		case <-request.Context().Done():
			return nil, request.Context().Err()
		}
	}
	done := make(chan error, 1)
	go func() { _, err := fixture.Gateway.Flush(context.Background()); done <- err }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("delivery did not start")
	}
	mode := ForwardAll
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := fixture.Gateway.Configure(ctx, ConfigureInput{ForwardMode: &mode}); err != nil {
		close(release)
		t.Fatal("display forwarding preference waited for or cancelled external delivery", err)
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("delivery did not settle")
	}
	if fixture.Sent.Load() != 1 {
		t.Fatal("preference caused extra external request")
	}
	fixture.Gateway.mu.Lock()
	defer fixture.Gateway.mu.Unlock()
	if fixture.Gateway.config.Outbox[0].Status != OutboxSent {
		t.Fatal("confirmed delivery became unknown after preference update")
	}
}
