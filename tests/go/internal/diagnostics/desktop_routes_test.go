package diagnostics

import (
	"context"
	"testing"
)

func TestDesktopRoutesRemainRecognizableWithoutRetainingQueriesOrUnknownPaths(t *testing.T) {
	logger := newLogger(t, Options{DataDir: t.TempDir(), Role: "controller"})
	for _, route := range []string{
		"/api/desktop/exit", "/api/desktop/cancel-exit", "/api/desktop/open",
		"/api/desktop/exit?token=synthetic-private-token",
		"/api/desktop/private-account",
	} {
		if !logger.Log("http.request", Fields{Method: "POST", Route: route}) {
			t.Fatal("bounded request metadata was refused")
		}
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	records, err := logger.Recent(context.Background(), 10)
	if err != nil || len(records) != 5 {
		t.Fatal("request metadata was not preserved", err)
	}
	for index, expected := range []string{"/api/desktop/exit", "/api/desktop/cancel-exit", "/api/desktop/open", "", ""} {
		if records[index].Route != expected {
			t.Fatal("fixed desktop route was lost or untrusted route content was retained")
		}
	}
}
