package updates

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type doerFunc func(*http.Request) (*http.Response, error)

func (function doerFunc) Do(request *http.Request) (*http.Response, error) { return function(request) }

func TestSemverOrderingPreservesArbitraryIntegerPrecision(t *testing.T) {
	for _, fixture := range []struct {
		left, right string
		order       int
	}{{"1.0.0-alpha", "1.0.0-alpha.1", -1}, {"1.0.0-beta.11", "1.0.0-rc.1", -1}, {"1.0.0-1", "1.0.0-alpha", -1}, {"1.0.0", "1.0.0+build", 0}, {"99999999999999999999.0.0", "99999999999999999998.9.9", 1}, {"0.4.7-beta.12", "0.4.7", -1}} {
		result, err := CompareVersions(fixture.left, fixture.right)
		if err != nil || result != fixture.order {
			t.Fatalf("order %s/%s: %d %v", fixture.left, fixture.right, result, err)
		}
	}
	for _, version := range []string{"v1.0.0", "1.01.0", "1.0.0-01", "1.0", "invalid"} {
		if _, err := CompareVersions(version, "1.0.0"); !errors.Is(err, ErrVersion) {
			t.Fatal("invalid semver accepted")
		}
	}
}

func releaseJSON(tag string) string {
	return `{"tag_name":"` + tag + `","draft":false,"prerelease":false,"html_url":"` + ReleasesURL + `/tag/` + tag + `","published_at":"2026-10-19T12:00:00Z","assets":[{"name":"dant_1.2.3_windows_x64_setup.exe","state":"uploaded","size":42,"digest":"sha256:` + strings.Repeat("A", 64) + `","browser_download_url":"` + ReleasesURL + `/download/` + tag + `/dant_1.2.3_windows_x64_setup.exe"}]}`
}

func TestPublicUpdateMetadataIsBoundedCachedAndDetached(t *testing.T) {
	var requests atomic.Int32
	service := New(Options{Version: "1.0.0", Now: func() time.Time { return time.Unix(1000, 0) }, HTTP: doerFunc(func(request *http.Request) (*http.Response, error) {
		requests.Add(1)
		if request.URL.String() != latestAPI || request.Header.Get("Authorization") != "" || request.Header.Get("User-Agent") != "dant-update-check" {
			t.Fatal("unexpected update request")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(releaseJSON("v1.2.3")))}, nil
	})})
	defer service.Close()
	if requests.Load() != 0 {
		t.Fatal("constructor contacted GitHub")
	}
	result, err := service.Check(context.Background(), "stable")
	if err != nil || !result.UpdateAvailable || result.Asset == nil || result.Asset.SHA256 != strings.Repeat("a", 64) {
		t.Fatal("valid update metadata rejected")
	}
	result.Asset.Name = "caller mutation"
	second, err := service.Check(context.Background(), "stable")
	if err != nil || requests.Load() != 1 || second.Asset.Name == "caller mutation" {
		t.Fatal("cache must be detached and avoid extra request")
	}
	writer := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "http://127.0.0.1/api/updates", nil)
	service.Handler().ServeHTTP(writer, request)
	if writer.Code != 405 || writer.Header().Get("Allow") != "GET" || writer.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("updates information accepted mutation")
	}
	service.Close()
	if _, err := service.Check(context.Background(), "stable"); err == nil {
		t.Fatal("closed service admitted request")
	}
}

func TestUpdateFailuresNeverExposeRemoteBodies(t *testing.T) {
	for _, fixture := range []struct {
		body   string
		status int
		code   string
	}{{"sensitive arbitrary output", 429, "UPDATE_RATE_LIMITED"}, {strings.Repeat("x", int(releaseMaxBytes)+1), 200, "UPDATE_INVALID_RELEASE"}, {`{"draft":false}`, 200, "UPDATE_INVALID_RELEASE"}} {
		service := New(Options{Version: "1.0.0", HTTP: doerFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: fixture.status, Body: io.NopCloser(strings.NewReader(fixture.body))}, nil
		})})
		_, err := service.Check(context.Background(), "stable")
		service.Close()
		var classified *Error
		if !errors.As(err, &classified) || classified.Code != fixture.code {
			t.Fatalf("unexpected failure classification: %v", err)
		}
	}
}

func TestInstallationLeaseFencesUnknownOutcomesAndBindsExactIdentity(t *testing.T) {
	state := InstallationSnapshot{Mode: "vm-controller", Authority: "vm", ProvisioningStatus: contracts.ProvisioningStatusIdle, Worker: contracts.WorkerSnapshot{Queue: []string{}}}
	var now atomic.Int64
	now.Store(1000)
	lease := NewInstallLease(LeaseOptions{Snapshot: func() InstallationSnapshot { return state }, Refresh: func(context.Context) error { return nil }, Now: func() time.Time { return time.UnixMilli(now.Load()) }, ID: func() string { return "fixture-lease" }})
	defer lease.Close()
	finish, err := lease.Enter()
	if err != nil {
		t.Fatal(err)
	}

	if _, err := lease.Acquire(context.Background()); !errors.Is(err, ErrInstallationDeferred) {
		t.Fatal("pending mutation admitted installer")
	}
	finish(false)
	finish(true)
	receipt, err := lease.Acquire(context.Background())
	if err != nil || receipt.LeaseID != "fixture-lease" {
		t.Fatal("quiescent installation rejected")
	}

	if _, err := lease.Enter(); !errors.Is(err, ErrInstallationDeferred) {
		t.Fatal("lease admitted mutation")
	}

	if _, err := lease.Renew("other"); !errors.Is(err, ErrInstallationDeferred) {
		t.Fatal("different lease identity renewed")
	}

	if pinned, err := lease.Pin(receipt.LeaseID); err != nil || pinned.ExpiresAt != now.Load()+DesktopTransitionTimeout.Milliseconds() {
		t.Fatal("pin deadline incorrect")
	}

	if err := lease.Release(receipt.LeaseID); err != nil {
		t.Fatal(err)
	}
	finish, err = lease.Enter()
	if err != nil {
		t.Fatal(err)
	}
	finish(true)
	if _, err := lease.Acquire(context.Background()); !errors.Is(err, ErrInstallationDeferred) {
		t.Fatal("unconfirmed action was treated as safe retry")
	}
	var payload struct {
		LeaseID   string `json:"leaseId"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	bytes, _ := json.Marshal(receipt)
	if json.Unmarshal(bytes, &payload) != nil || payload.LeaseID != receipt.LeaseID {
		t.Fatal("lease receipt wire mismatch")
	}
}

func TestMutationClassificationRetainsEncodedPathAndMethodRules(t *testing.T) {
	for _, fixture := range []struct {
		method, path string
		want         bool
	}{{"POST", "/api/messages?token=fixture", true}, {"PATCH", "/api/%73ettings", true}, {"POST", "/api/desktop/open", false}, {"DELETE", "/api/updates/install-lease/fixture", false}, {"GET", "/api/messages", false}, {"POST", "/outside", false}} {
		result, err := UpdateSensitiveRequest(fixture.method, fixture.path)
		if err != nil || result != fixture.want {
			t.Fatal("mutation classification differs")
		}
	}
}
