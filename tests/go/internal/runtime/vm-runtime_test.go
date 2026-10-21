package runtime

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type probeClient func(*http.Request) (*http.Response, error)

func (value probeClient) Do(request *http.Request) (*http.Response, error) { return value(request) }

func TestMaintenanceVMHostProbeDoesNotRequireDesktopAndRejectsHostsOrPrivilegedUsers(t *testing.T) {
	calls := 0
	detect := func(ctx context.Context) (string, error) {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("unbounded VM probe")
		}
		return "kvm", nil
	}
	if err := VerifyVMHost(context.Background(), "linux", 1000, detect); err != nil || calls != 1 {
		t.Fatal(err)
	}
	for _, input := range []struct {
		platform string
		uid      int
	}{{"windows", 1000}, {"linux", 0}, {"darwin", 1000}} {
		if err := VerifyVMHost(context.Background(), input.platform, input.uid, detect); !errors.Is(err, ErrWorkerRole) {
			t.Fatal("host accepted as execution VM")
		}
	}
	if calls != 1 {
		t.Fatal("role rejection executed a host probe")
	}
	if err := VerifyVMHost(context.Background(), "linux", 1000, func(context.Context) (string, error) { return "none", nil }); !errors.Is(err, ErrVMUnavailable) {
		t.Fatal("bare metal accepted as VM")
	}
}

func TestExecutionProbeRequiresPositiveHealthAndPNGSignature(t *testing.T) {
	for _, healthy := range []bool{true, false} {
		calls := 0
		client := probeClient(func(request *http.Request) (*http.Response, error) {
			calls++
			body := `{"ok":true}`
			if request.URL.Path == "/screen" {
				body = string([]byte{137, 80, 78, 71, 13, 10, 26, 10})
			}
			if !healthy && request.URL.Path == "/health" {
				body = `{"ok":false}`
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
		})
		err := VerifyVMRuntime(context.Background(), RuntimeVerification{Platform: "linux", UID: 1000, GuestOrigin: "http://127.0.0.1:4320", Client: client, Detect: func(context.Context) (string, error) { return "kvm", nil }})
		if healthy && (err != nil || calls != 2) || !healthy && (!errors.Is(err, ErrDesktopUnavailable) || calls != 1) {
			t.Fatal("health/screen execution boundary changed", err)
		}
	}
}
