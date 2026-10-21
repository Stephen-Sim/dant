package updates

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type failedReleaseBody struct{ closed bool }

func (*failedReleaseBody) Read([]byte) (int, error) {
	return 0, errors.New("synthetic private transport failure")
}
func (body *failedReleaseBody) Close() error {
	body.closed = true
	return nil
}

func TestReleaseTransportFailuresAreBoundedClassifiedAndCloseTheirBodies(t *testing.T) {
	for _, fixture := range []struct {
		name, version, channel, body, code string
		status                             int
		size                               int64
		failure                            error
	}{
		{"invalid-version", "invalid", "stable", "", "UPDATE_INVALID_RELEASE", 200, 0, nil},
		{"invalid-channel", "1.0.0", "other", "", "UPDATE_INVALID_CHANNEL", 200, 0, nil},
		{"server-failure", "1.0.0", "stable", "private body", "UPDATE_UNAVAILABLE", 500, 0, nil},
		{"rate-limit", "1.0.0", "stable", "private body", "UPDATE_RATE_LIMITED", 403, 0, nil},
		{"large-content-length", "1.0.0", "stable", "{}", "UPDATE_INVALID_RELEASE", 200, releaseMaxBytes + 1, nil},
		{"malformed-stable", "1.0.0", "stable", "{", "UPDATE_INVALID_RELEASE", 200, 0, nil},
		{"malformed-beta", "1.0.0", "beta", "{}", "UPDATE_INVALID_RELEASE", 200, 0, nil},
		{"too-many-beta", "1.0.0", "beta", "[" + strings.Repeat("{},", releasePageSize) + "{}]", "UPDATE_INVALID_RELEASE", 200, 0, nil},
		{"deadline", "1.0.0", "stable", "", "UPDATE_TIMEOUT", 200, 0, context.DeadlineExceeded},
		{"transport", "1.0.0", "stable", "", "UPDATE_UNAVAILABLE", 200, 0, errors.New("private network detail")},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			service := New(Options{Version: fixture.version, HTTP: doerFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: fixture.status, ContentLength: fixture.size, Body: io.NopCloser(strings.NewReader(fixture.body))}, fixture.failure
			})})
			defer service.Close()
			_, err := service.Check(t.Context(), fixture.channel)
			var classified *Error
			if !errors.As(err, &classified) || classified.Code != fixture.code || strings.Contains(classified.Message, "private") {
				t.Fatal("unexpected update failure classification", err)
			}
			response := httptest.NewRecorder()
			service.Handler().ServeHTTP(response, httptest.NewRequest("GET", "http://localhost/api/updates?channel="+fixture.channel, nil))
			if response.Code != classified.Status || strings.Contains(response.Body.String(), "private") {
				t.Fatal("transport failure escaped the read-only API")
			}
		})
	}
	body := &failedReleaseBody{}
	service := New(Options{Version: "1.0.0", HTTP: doerFunc(func(*http.Request) (*http.Response, error) { return &http.Response{StatusCode: 200, Body: body}, nil })})
	defer service.Close()
	if _, err := service.Check(t.Context(), "stable"); err == nil || !body.closed {
		t.Fatal("failed response body was retained", err)
	}
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest("GET", "http://localhost/api/version", nil))
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"version":"1.0.0"`) {
		t.Fatal("local version information required a remote response")
	}
}

func TestBetaPaginationChoosesTheNewestValidReleaseAndRejectsAnUnboundedHistory(t *testing.T) {
	for _, unbounded := range []bool{false, true} {
		pages := 0
		service := New(Options{Version: "1.0.0", HTTP: doerFunc(func(request *http.Request) (*http.Response, error) {
			pages++
			if request.URL.Query().Get("page") != "" && request.URL.Query().Get("per_page") != "100" {
				t.Fatal("release pagination escaped its bound")
			}
			body := "[" + strings.Repeat("null,", releasePageSize-1) + releaseJSON("v1.2.3") + "]"
			if pages == 2 && !unbounded {
				body = "[false," + releaseJSON("v1.3.0") + ",{}," + releaseJSON("v1.1.0") + "]"
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
		})})
		result, err := service.Check(t.Context(), "beta")
		service.Close()
		if unbounded {
			var classified *Error
			if !errors.As(err, &classified) || classified.Code != "UPDATE_INVALID_RELEASE" || pages != releasePageLimit {
				t.Fatal("unbounded release history was accepted", err, pages)
			}
		} else if err != nil || result.LatestVersion != "1.3.0" || pages != 2 {
			t.Fatal("release selection did not compare all bounded pages", err, pages)
		}
	}
}

func TestCoalescedReleaseChecksRetainIndependentCancellationAndShutdownOwnership(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		ready := make(chan struct{})
		release := make(chan struct{})
		service := New(Options{Version: "1.0.0", HTTP: doerFunc(func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			close(ready)
			select {
			case <-release:
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(releaseJSON("v1.2.3")))}, nil
			case <-request.Context().Done():
				return nil, request.Context().Err()
			}
		})})
		defer service.Close()
		first := make(chan error, 1)
		go func() {
			_, err := service.Check(t.Context(), "")
			first <- err
		}()
		<-ready
		ctx, cancel := context.WithCancel(t.Context())
		second := make(chan error, 1)
		go func() {
			_, err := service.Check(ctx, "stable")
			second <- err
		}()
		third := make(chan CheckResult, 1)
		go func() {
			result, err := service.Check(t.Context(), "stable")
			if err != nil {
				t.Error(err)
			}
			third <- result
		}()
		synctest.Wait()
		cancel()
		if err := <-second; !errors.Is(err, context.Canceled) {
			t.Fatal("cancelled waiter changed the shared check", err)
		}
		close(release)
		if err := <-first; err != nil {
			t.Fatal(err)
		}
		if result := <-third; result.LatestVersion != "1.2.3" || calls.Load() != 1 {
			t.Fatal("coalesced check was repeated")
		}
	})
	synctest.Test(t, func(t *testing.T) {
		started := make(chan struct{})
		service := New(Options{Version: "1.0.0", HTTP: doerFunc(func(request *http.Request) (*http.Response, error) {
			close(started)
			<-request.Context().Done()
			return nil, request.Context().Err()
		})})
		done := make(chan error, 1)
		go func() {
			_, err := service.Check(t.Context(), "stable")
			done <- err
		}()
		<-started
		service.Close()
		if err := <-done; err == nil {
			t.Fatal("shutdown retained an in-flight request")
		}
		if len(service.cached) != 0 {
			t.Fatal("shutdown cached an unconfirmed result")
		}
	})
}

func TestInstallLeaseExpiryDefaultsAndClosedOperationsRemainFenced(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		state := InstallationSnapshot{Mode: "vm-controller", Authority: "vm", ProvisioningStatus: contracts.ProvisioningStatusIdle, Worker: contracts.WorkerSnapshot{Queue: []string{}}}
		released := 0
		lease := NewInstallLease(LeaseOptions{Snapshot: func() InstallationSnapshot { return state }, Refresh: func(context.Context) error { return nil }, TTL: time.Second, OnRelease: func() { released++ }})
		receipt, err := lease.Acquire(t.Context())
		if err != nil || len(receipt.LeaseID) != 36 {
			t.Fatal("default lease identity failed", err)
		}
		synctest.Wait()
		time.Sleep(2 * time.Second)
		synctest.Wait()
		if lease.Current() != nil || released != 1 {
			t.Fatal("expired install lease remained active")
		}
		lease.Close()
		if _, err := lease.Renew(receipt.LeaseID); !errors.Is(err, ErrInstallationDeferred) {
			t.Fatal("closed lease was renewed", err)
		}
		if err := lease.Release(receipt.LeaseID); !errors.Is(err, ErrInstallationDeferred) {
			t.Fatal("stale lease was released", err)
		}
		if err := lease.AssertQuiescent(0); !errors.Is(err, ErrInstallationDeferred) {
			t.Fatal("closed lease admitted installation", err)
		}
	})
	lease := NewInstallLease(LeaseOptions{})
	defer lease.Close()
	if _, err := lease.Acquire(t.Context()); !errors.Is(err, ErrInstallationDeferred) {
		t.Fatal("missing refresh capability was treated as safe", err)
	}
	for _, value := range []string{"", "%ZZ"} {
		if _, err := UpdateSensitiveRequest("POST", value); !errors.Is(err, ErrInstallationDeferred) {
			t.Fatal("invalid URL bypassed installation guard", err)
		}
	}
}
