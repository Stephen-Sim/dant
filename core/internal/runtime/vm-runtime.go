package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const (
	RuntimeProbeTimeout = 5 * time.Second
	ScreenProbeTimeout  = 10 * time.Second
	GuestTimeout        = 15 * time.Second
	HealthMaxBytes      = 1024 * 1024
)

var (
	ErrWorkerRole         = errors.New("executor_requires_ordinary_linux_vm")
	ErrVMUnavailable      = errors.New("executor_vm_unavailable")
	ErrDesktopUnavailable = errors.New("executor_desktop_unavailable")
	ErrStopUnconfirmed    = errors.New("executor_stop_unconfirmed")
	ErrConnectionChanged  = errors.New("executor_connection_changed")
)

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}
type RuntimeVerification struct {
	Platform    string
	UID         int
	GuestOrigin string
	Client      HTTPDoer
	Detect      func(context.Context) (string, error)
}

func ValidateGuestOrigin(origin string) error {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return ErrVMUnavailable
	}
	return nil
}

func DetectVM(ctx context.Context) (string, error) {
	output, err := exec.CommandContext(ctx, "systemd-detect-virt", "--vm").Output()
	if err != nil {
		return "", ErrVMUnavailable
	}
	return strings.TrimSpace(string(output)), nil
}

func VerifyVMRuntime(ctx context.Context, options RuntimeVerification) error {
	if err := VerifyVMHost(ctx, options.Platform, options.UID, options.Detect); err != nil {
		return err
	}
	if ValidateGuestOrigin(options.GuestOrigin) != nil {
		return ErrVMUnavailable
	}
	if options.Client == nil {
		options.Client = &http.Client{Timeout: GuestTimeout}
	}
	probe, cancel := context.WithTimeout(ctx, RuntimeProbeTimeout)
	request, err := http.NewRequestWithContext(probe, http.MethodGet, strings.TrimSuffix(options.GuestOrigin, "/")+"/health", nil)
	if err != nil {
		cancel()
		return ErrVMUnavailable
	}
	response, err := options.Client.Do(request)
	if err != nil {
		cancel()
		return ErrDesktopUnavailable
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, HealthMaxBytes+1))
	response.Body.Close()
	cancel()
	if readErr != nil || len(data) > HealthMaxBytes || response.StatusCode < 200 || response.StatusCode >= 300 {
		return ErrDesktopUnavailable
	}
	body, err := contracts.DecodeObject(data, HealthMaxBytes)
	if err != nil {
		return ErrDesktopUnavailable
	}
	var ok bool
	if json.Unmarshal(body["ok"], &ok) != nil || !ok {
		return ErrDesktopUnavailable
	}
	probe, cancel = context.WithTimeout(ctx, ScreenProbeTimeout)
	defer cancel()
	request, err = http.NewRequestWithContext(probe, http.MethodGet, strings.TrimSuffix(options.GuestOrigin, "/")+"/screen", nil)
	if err != nil {
		return ErrDesktopUnavailable
	}
	response, err = options.Client.Do(request)
	if err != nil {
		return ErrDesktopUnavailable
	}
	defer response.Body.Close()
	var signature [8]byte
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ErrDesktopUnavailable
	}
	if _, err = io.ReadFull(response.Body, signature[:]); err != nil || !bytes.Equal(signature[:], []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		return ErrDesktopUnavailable
	}
	return nil
}

// VerifyVMHost is the maintenance role boundary. A stopped desktop bridge does
// not prevent safe preparation, but a host OS or privileged user always does.
func VerifyVMHost(
	ctx context.Context,
	platform string,
	uid int,
	detect func(context.Context) (string, error)) error {
	if platform != "linux" || uid <= 0 {
		return ErrWorkerRole
	}
	if detect == nil {
		detect = DetectVM
	}
	probe, cancel := context.WithTimeout(ctx, RuntimeProbeTimeout)
	defer cancel()
	virtualization, err := detect(probe)
	if err != nil || contracts.TrimText(virtualization) == "" || contracts.TrimText(virtualization) == "none" {
		return ErrVMUnavailable
	}
	return nil
}
