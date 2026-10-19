// Package updates reads public release metadata and fences desktop installation.
package updates

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const RepositoryURL = "https://github.com/Stephen-Sim/dant"
const ReleasesURL = RepositoryURL + "/releases"
const latestAPI = "https://api.github.com/repos/Stephen-Sim/dant/releases/latest"
const releasesAPI = "https://api.github.com/repos/Stephen-Sim/dant/releases"
const MaxInstallerBytes = int64(512 * 1024 * 1024)
const releaseMaxBytes = int64(2 * 1024 * 1024)
const releaseTimeout = 10 * time.Second
const releaseCache = time.Minute
const releasePageLimit = 10
const releasePageSize = 100

type Error struct {
	Code    string
	Status  int
	Message string
}

func (error *Error) Error() string { return error.Code }
func updateError(code string) *Error {
	result := &Error{Code: code, Status: http.StatusBadGateway, Message: "Updates could not be checked. Check your connection and try again."}
	switch code {
	case "UPDATE_INVALID_CHANNEL":
		result.Status = 400
		result.Message = "Choose Stable or Beta for updates."
	case "UPDATE_TIMEOUT":
		result.Status = 504
		result.Message = "The update check timed out. Try again."
	case "UPDATE_RATE_LIMITED":
		result.Status = 503
		result.Message = "GitHub is limiting update checks. Try again later."
	case "UPDATE_INVALID_RELEASE":
		result.Message = "GitHub returned an invalid release. Try again later."
	}

	return result
}

type InstallerAsset struct {
	Version string `json:"version"`
	Channel string `json:"channel"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
	Name    string `json:"name"`
}

type CheckResult struct {
	CurrentVersion  string          `json:"currentVersion"`
	LatestVersion   string          `json:"latestVersion"`
	UpdateAvailable bool            `json:"updateAvailable"`
	ReleaseURL      string          `json:"releaseUrl"`
	CheckedAt       string          `json:"checkedAt"`
	Channel         string          `json:"channel"`
	Asset           *InstallerAsset `json:"asset"`
}

type Info struct {
	Version       string `json:"version"`
	RepositoryURL string `json:"repositoryUrl"`
	ReleasesURL   string `json:"releasesUrl"`
}

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type Options struct {
	Version  string
	HTTP     HTTPDoer
	Now      func() time.Time
	Timeout  time.Duration
	CacheTTL time.Duration
}

type cachedRelease struct {
	at     time.Time
	result CheckResult
}

type releaseFlight struct {
	done   chan struct{}
	result CheckResult
	err    error
}

type Service struct {
	mu       sync.Mutex
	version  string
	http     HTTPDoer
	now      func() time.Time
	timeout  time.Duration
	cacheTTL time.Duration
	cached   map[string]cachedRelease
	pending  map[string]*releaseFlight
	ctx      context.Context
	cancel   context.CancelFunc
	closed   bool
}

func New(options Options) *Service {
	if options.HTTP == nil {
		options.HTTP = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect_disallowed") }}
	}

	if options.Now == nil {
		options.Now = time.Now
	}

	if options.Timeout <= 0 {
		options.Timeout = releaseTimeout
	}

	if options.CacheTTL <= 0 {
		options.CacheTTL = releaseCache
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{
		version:  options.Version,
		http:     options.HTTP,
		now:      options.Now,
		timeout:  options.Timeout,
		cacheTTL: options.CacheTTL,
		cached:   make(map[string]cachedRelease),
		pending:  make(map[string]*releaseFlight),
		ctx:      ctx,
		cancel:   cancel,
	}
}

func (service *Service) Info() Info {
	return Info{Version: service.version, RepositoryURL: RepositoryURL, ReleasesURL: ReleasesURL}
}

func cloneResult(result CheckResult) CheckResult {
	if result.Asset != nil {
		asset := *result.Asset
		result.Asset = &asset
	}

	return result
}

// Check coalesces reads only. No installer or remote action is started here.
func (service *Service) Check(ctx context.Context, channel string) (CheckResult, error) {
	if channel == "" {
		channel = "stable"
	}

	if channel != "stable" && channel != "beta" {
		return CheckResult{}, updateError("UPDATE_INVALID_CHANNEL")
	}
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		return CheckResult{}, updateError("UPDATE_UNAVAILABLE")
	}

	if cached, exists := service.cached[channel]; exists && service.now().Sub(cached.at) < service.cacheTTL {
		service.mu.Unlock()
		return cloneResult(cached.result), nil
	}

	if pending, exists := service.pending[channel]; exists {
		service.mu.Unlock()
		select {
		case <-ctx.Done():
			return CheckResult{}, ctx.Err()
		case <-pending.done:
			return cloneResult(pending.result), pending.err
		}
	}
	pending := &releaseFlight{done: make(chan struct{})}
	service.pending[channel] = pending
	service.mu.Unlock()
	requestContext, cancel := context.WithTimeout(ctx, service.timeout)
	stop := context.AfterFunc(service.ctx, cancel)
	result, err := service.load(requestContext, channel)
	stop()
	cancel()
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			err = updateError("UPDATE_TIMEOUT")
		} else {
			var classified *Error
			if !errors.As(err, &classified) {
				err = updateError("UPDATE_UNAVAILABLE")
			}
		}
	}
	service.mu.Lock()
	pending.result, pending.err = cloneResult(result), err
	if err == nil && !service.closed {
		service.cached[channel] = cachedRelease{at: service.now(), result: cloneResult(result)}
	}
	delete(service.pending, channel)
	close(pending.done)
	service.mu.Unlock()
	return result, err
}

func (service *Service) Close() {
	service.mu.Lock()
	service.closed = true
	clear(service.cached)
	service.cancel()
	service.mu.Unlock()
}

type releaseAsset struct {
	Name        string  `json:"name"`
	State       string  `json:"state"`
	Size        float64 `json:"size"`
	Digest      string  `json:"digest"`
	DownloadURL string  `json:"browser_download_url"`
}

type githubRelease struct {
	Tag         string          `json:"tag_name"`
	Draft       *bool           `json:"draft"`
	Prerelease  *bool           `json:"prerelease"`
	HTMLURL     string          `json:"html_url"`
	PublishedAt string          `json:"published_at"`
	Assets      json.RawMessage `json:"assets"`
}

var assetDigest = regexp.MustCompile(`^sha256:[a-fA-F0-9]{64}$`)

type published struct {
	version string
	url     string
	asset   *InstallerAsset
}

func publishedRelease(release githubRelease, channel string) *published {
	version := strings.TrimPrefix(release.Tag, "v")
	parsed, err := parseVersion(version)
	if err != nil || release.Draft == nil || *release.Draft || release.Prerelease == nil || *release.Prerelease != (len(parsed.prerelease) > 0) || strings.Contains(release.Tag, "+") || (channel == "stable" && len(parsed.prerelease) > 0) || release.HTMLURL != ReleasesURL+"/tag/"+release.Tag {
		return nil
	}

	if _, err := time.Parse(time.RFC3339Nano, release.PublishedAt); err != nil {
		return nil
	}
	result := &published{version: version, url: release.HTMLURL}
	name := "dant_" + version + "_windows_x64_setup.exe"
	var candidate *releaseAsset
	matches := 0
	var assets []json.RawMessage
	_ = json.Unmarshal(release.Assets, &assets)
	for _, raw := range assets {
		var named struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &named) == nil && named.Name == name {
			matches++
			var asset releaseAsset
			if json.Unmarshal(raw, &asset) == nil {
				candidate = &asset
			}
		}
	}

	if matches == 1 && candidate != nil {
		size := candidate.Size
		expected := ReleasesURL + "/download/" + release.Tag + "/" + name
		if !math.IsNaN(size) && !math.IsInf(size, 0) && math.Trunc(size) == size && size > 0 && size <= float64(MaxInstallerBytes) && candidate.State == "uploaded" && assetDigest.MatchString(candidate.Digest) && candidate.DownloadURL == expected {
			result.asset = &InstallerAsset{Version: version, Channel: channel, URL: expected, SHA256: strings.ToLower(candidate.Digest[7:]), Size: int64(size), Name: name}
		}
	}

	return result
}

func (service *Service) load(ctx context.Context, channel string) (CheckResult, error) {
	if _, err := parseVersion(service.version); err != nil {
		return CheckResult{}, updateError("UPDATE_INVALID_RELEASE")
	}
	var selected *published
	for page := 1; page <= releasePageLimit; page++ {
		url := latestAPI
		if channel == "beta" {
			url = releasesAPI + "?per_page=100&page=" + strconv.Itoa(page)
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return CheckResult{}, updateError("UPDATE_UNAVAILABLE")
		}
		request.Header.Set("Accept", "application/vnd.github+json")
		request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		request.Header.Set("User-Agent", "dant-update-check")
		response, err := service.http.Do(request)
		if err != nil {
			return CheckResult{}, err
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			response.Body.Close()
			if response.StatusCode == 403 || response.StatusCode == 429 {
				return CheckResult{}, updateError("UPDATE_RATE_LIMITED")
			}
			return CheckResult{}, updateError("UPDATE_UNAVAILABLE")
		}
		if response.ContentLength > releaseMaxBytes {
			response.Body.Close()
			return CheckResult{}, updateError("UPDATE_INVALID_RELEASE")
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, releaseMaxBytes+1))
		response.Body.Close()
		if readErr != nil {
			return CheckResult{}, readErr
		}
		if int64(len(body)) > releaseMaxBytes {
			return CheckResult{}, updateError("UPDATE_INVALID_RELEASE")
		}
		if channel == "stable" {
			var release githubRelease
			if json.Unmarshal(body, &release) != nil {
				return CheckResult{}, updateError("UPDATE_INVALID_RELEASE")
			}
			selected = publishedRelease(release, channel)
			break
		}
		var releases []json.RawMessage
		if json.Unmarshal(body, &releases) != nil || len(releases) > releasePageSize {
			return CheckResult{}, updateError("UPDATE_INVALID_RELEASE")
		}
		for _, raw := range releases {
			var release githubRelease
			if json.Unmarshal(raw, &release) != nil {
				continue
			}
			candidate := publishedRelease(release, channel)
			if candidate == nil {
				continue
			}
			if selected == nil {
				selected = candidate
			} else if comparison, _ := CompareVersions(candidate.version, selected.version); comparison > 0 {
				selected = candidate
			}
		}
		if len(releases) < releasePageSize {
			break
		}
		if page == releasePageLimit {
			return CheckResult{}, updateError("UPDATE_INVALID_RELEASE")
		}
	}

	if selected == nil {
		return CheckResult{}, updateError("UPDATE_INVALID_RELEASE")
	}
	comparison, _ := CompareVersions(selected.version, service.version)
	return CheckResult{
		CurrentVersion:  service.version,
		LatestVersion:   selected.version,
		UpdateAvailable: comparison > 0,
		ReleaseURL:      selected.url,
		CheckedAt:       service.now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Channel:         channel,
		Asset:           selected.asset,
	}, nil
}

func (service *Service) Handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Content-Type", "application/json")
		if request.Method != http.MethodGet {
			writer.Header().Set("Allow", "GET")
			writer.WriteHeader(405)
			json.NewEncoder(writer).Encode(struct {
				Error string `json:"error"`
			}{"Update information is read-only."})
			return
		}
		if request.URL.Path == "/api/version" {
			json.NewEncoder(writer).Encode(service.Info())
			return
		}
		result, err := service.Check(request.Context(), request.URL.Query().Get("channel"))
		if err != nil {
			var classified *Error
			if !errors.As(err, &classified) {
				classified = updateError("UPDATE_UNAVAILABLE")
			}
			writer.WriteHeader(classified.Status)
			json.NewEncoder(writer).Encode(struct {
				Error string `json:"error"`
				Code  string `json:"code"`
			}{classified.Message, classified.Code})
			return
		}
		json.NewEncoder(writer).Encode(result)
	})
}
