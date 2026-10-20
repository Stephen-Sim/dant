package diagnostics

import (
	"context"
	"errors"
	"sync"
	"testing"
)

func TestRecentSnapshotsStayAvailableWhileTheOwnedWriterAppendsAndRotates(t *testing.T) {
	logger := newLogger(t, Options{
		DataDir: t.TempDir(), Role: "controller",
		MaxFileBytes: 1024, MaxTotalBytes: 16 * 1024,
	})
	var workers sync.WaitGroup
	errorsSeen := make(chan error, 4)
	for index := 0; index < 4; index++ {
		workers.Go(func() {
			for count := int64(0); count < 80; count++ {
				logger.Log("http.request", Fields{Count: &count, Route: "/api/diagnostics"})
				records, err := logger.Recent(t.Context(), 30)
				if err != nil {
					errorsSeen <- err
					return
				}
				for _, record := range records {
					if record.Event != "http.request" || record.Count == nil || record.Route != "/api/diagnostics" {
						errorsSeen <- errors.New("a diagnostic snapshot contained a partial record")
						return
					}
				}
			}
		})
	}
	workers.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Error(err)
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	if status := logger.Status(); status.LastError != nil || status.TotalBytes > 16*1024 {
		t.Fatal("concurrent readers disrupted the bounded writer")
	}
}

func TestRecentHonorsCancelledRequestsWithoutChangingLoggerLifetime(t *testing.T) {
	logger := newLogger(t, Options{DataDir: t.TempDir(), Role: "controller"})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := logger.Recent(ctx, 20); !errors.Is(err, context.Canceled) {
		t.Fatal("a cancelled diagnostic read continued")
	}
	if !logger.Log("service.ready", Fields{}) {
		t.Fatal("cancelling a read stopped the writer")
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	items, err := logger.Recent(t.Context(), 20)
	if err != nil || len(items) != 1 || items[0].Event != "service.ready" {
		t.Fatal("request cancellation changed the owned logger lifetime")
	}
}
