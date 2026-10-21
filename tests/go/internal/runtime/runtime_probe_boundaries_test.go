package runtime

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
)

func TestRuntimeProbeValidatesHealthAndScreenThroughAnIsolatedLocalServer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case desktopPaths.Health:
			_, _ = io.WriteString(writer, `{"ok":true}`)
		case desktopPaths.Screen:
			_, _ = writer.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10})
		default:
			t.Error("unvalidated runtime probe route")
			writer.WriteHeader(404)
		}
	}))
	defer server.Close()
	if err := VerifyVMRuntime(t.Context(), RuntimeVerification{Platform: "linux", UID: 1000, GuestOrigin: server.URL, Detect: func(context.Context) (string, error) { return "fixture-vm", nil }}); err != nil {
		t.Fatal("isolated VM proof and desktop signature were rejected", err)
	}
}

func TestRuntimeProbeClassifiesEachInvalidHealthAndDesktopBoundary(t *testing.T) {
	for _, test := range []struct {
		name, health, screen       string
		healthStatus, screenStatus int
		failHealth, failScreen     bool
	}{
		{"health transport", "", "", 200, 200, true, false},
		{"health status", `{"ok":true}`, "", 503, 200, false, false},
		{"health malformed", `{`, "", 200, 200, false, false},
		{"health false", `{"ok":false}`, "", 200, 200, false, false},
		{"health huge", strings.Repeat("x", HealthMaxBytes+1), "", 200, 200, false, false},
		{"screen transport", `{"ok":true}`, "", 200, 200, false, true},
		{"screen status", `{"ok":true}`, "", 200, 503, false, false},
		{"screen signature", `{"ok":true}`, "invalid!", 200, 200, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := guestBoundaryClient(func(request *http.Request) (*http.Response, error) {
				status, body, fail := test.healthStatus, test.health, test.failHealth
				if request.URL.Path == desktopPaths.Screen {
					status, body, fail = test.screenStatus, test.screen, test.failScreen
				}
				if fail {
					return nil, errors.New("isolated probe failure")
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			if err := VerifyVMRuntime(t.Context(), RuntimeVerification{Platform: "linux", UID: 1000, GuestOrigin: "http://127.0.0.1:4321", Client: client, Detect: func(context.Context) (string, error) { return "fixture-vm", nil }}); !errors.Is(err, ErrDesktopUnavailable) {
				t.Fatal("failed runtime proof did not preserve its classified boundary", err)
			}
		})
	}
	if err := VerifyVMRuntime(t.Context(), RuntimeVerification{Platform: "linux", UID: 1000, GuestOrigin: "https://foreign.invalid", Detect: func(context.Context) (string, error) { return "fixture-vm", nil }}); !errors.Is(err, ErrVMUnavailable) {
		t.Fatal("foreign desktop origin accepted", err)
	}
	if err := ValidateGuestOrigin("http://foreign.invalid:4321"); !errors.Is(err, ErrVMUnavailable) {
		t.Fatal("non-loopback desktop origin accepted", err)
	}
}

func TestDefaultRuntimeDetectionUsesOnlyAnIsolatedCommandFixture(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("PATH", directory)
	if goruntime.GOOS == "linux" {
		if err := os.WriteFile(filepath.Join(directory, "systemd-detect-virt"), []byte("#!/bin/sh\nprintf 'fixture-vm\\n'\n"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := VerifyVMHost(t.Context(), "linux", 1000, nil); err != nil {
			t.Fatal("default detector did not use its isolated fixture command", err)
		}
	} else if _, err := DetectVM(t.Context()); !errors.Is(err, ErrVMUnavailable) {
		t.Fatal("unavailable detector invented virtualization proof", err)
	}
}
