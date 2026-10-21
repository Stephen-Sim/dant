package security

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	SessionTokenBytes      = 32
	BackupPassphraseHeader = "X-Dant-Backup-Passphrase"
	CoreRuntime            = "go"
	CoreProtocolVersion    = 1
)

type SessionAuth struct {
	token   string
	mode    string
	apiPort int
	devPort int
	build   SessionBuild
}

type SessionBuild struct {
	Version string `json:"version"`
	Source  string `json:"source"`
}

var sessionSource = regexp.MustCompile(`^[a-f0-9]{40}$`)
var sessionVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$`)

type SessionInfo struct {
	Token    string `json:"token"`
	Product  string `json:"product"`
	Mode     string `json:"mode"`
	Runtime  string `json:"runtime"`
	Protocol int    `json:"protocol"`
	Version  string `json:"version,omitempty"`
	Source   string `json:"source,omitempty"`
}

func NewSessionAuth(mode string, apiPort, devPort int, builds ...SessionBuild) (*SessionAuth, error) {
	return newSessionAuth(mode, apiPort, devPort, rand.Reader, builds...)
}

func newSessionAuth(mode string, apiPort, devPort int, entropy io.Reader, builds ...SessionBuild) (*SessionAuth, error) {
	if (mode != "controller" && mode != "worker") || apiPort < 1 || apiPort > 65535 || devPort < 1 || devPort > 65535 {
		return nil, errors.New("invalid_session_configuration")
	}
	if len(builds) > 1 {
		return nil, errors.New("invalid_session_configuration")
	}
	var build SessionBuild
	if len(builds) == 1 {
		build = builds[0]
		if !sessionSource.MatchString(build.Source) || !sessionVersion.MatchString(build.Version) {
			return nil, errors.New("invalid_session_build")
		}
	}
	secret := make([]byte, SessionTokenBytes)
	if _, err := io.ReadFull(entropy, secret); err != nil {
		return nil, errors.New("session_unavailable")
	}
	defer clear(secret)
	return &SessionAuth{token: hex.EncodeToString(secret), mode: mode, apiPort: apiPort, devPort: devPort, build: build}, nil
}

func (auth *SessionAuth) Info() SessionInfo {
	return SessionInfo{
		Token: auth.token, Product: "dant", Mode: auth.mode,
		Runtime: CoreRuntime, Protocol: CoreProtocolVersion,
		Version: auth.build.Version, Source: auth.build.Source,
	}
}

func (auth *SessionAuth) ServeSession(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(writer).Encode(auth.Info())
}

func localHost(host string) bool {
	if hostname, _, err := net.SplitHostPort(host); err == nil {
		host = hostname
	}
	return host == "127.0.0.1" || host == "localhost"
}

func (auth *SessionAuth) AllowedOrigin(origin string) bool {
	if origin == "" || origin == "http://tauri.localhost" || origin == "tauri://localhost" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.User != nil || parsed.Opaque != "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawFragment != "" ||
		parsed.Path != "" || parsed.RawPath != "" {
		return false
	}
	if parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" {
		return false
	}
	if origin != parsed.Scheme+"://"+parsed.Host {
		return false
	}
	port := parsed.Port()
	if port == "" {
		return true
	}
	if (parsed.Scheme == "http" && port == "80") || (parsed.Scheme == "https" && port == "443") {
		return false
	}
	value, err := strconv.Atoi(port)
	return err == nil && strconv.Itoa(value) == port && (value == auth.apiPort || value == auth.devPort)
}

func (auth *SessionAuth) CheckToken(request *http.Request, allowQuery bool) bool {
	match := func(value string) bool {
		return len(value) == len(auth.token) && subtle.ConstantTimeCompare([]byte(value), []byte(auth.token)) == 1
	}
	headers := request.Header.Values("X-Dant-Token")
	if len(headers) == 1 && match(headers[0]) {
		return true
	}
	if allowQuery {
		query, err := url.ParseQuery(request.URL.RawQuery)
		if err == nil && len(query["token"]) == 1 && match(query["token"][0]) {
			return true
		}
	}
	return false
}

// CheckUpgrade preserves the existing event-stream origin allowlist and exact
// query-token identity. It does not reflect an arbitrary origin into a socket.
func (auth *SessionAuth) CheckUpgrade(request *http.Request) bool {
	if !localHost(request.Host) || len(request.Header.Values("Origin")) > 1 {
		return false
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil || len(query["token"]) != 1 || len(query["token"][0]) != len(auth.token) ||
		subtle.ConstantTimeCompare([]byte(query["token"][0]), []byte(auth.token)) != 1 {
		return false
	}
	origin := request.Header.Get("Origin")
	if origin == "" || origin == "http://tauri.localhost" || origin == "tauri://localhost" {
		return true
	}
	return origin == "http://127.0.0.1:"+strconv.Itoa(auth.apiPort) ||
		origin == "http://localhost:"+strconv.Itoa(auth.apiPort) ||
		origin == "http://127.0.0.1:"+strconv.Itoa(auth.devPort) ||
		origin == "http://localhost:"+strconv.Itoa(auth.devPort)
}

// Middleware guards every local request before the owning HTTP router. Only
// the session bootstrap is public; the internal credential bridge receives its
// separate owner-scoped authenticator through the explicit callback.
func (auth *SessionAuth) Middleware(next http.Handler, internalCredentialBridge func(*http.Request) bool) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		origin := request.Header.Get("Origin")
		if !localHost(request.Host) || !auth.AllowedOrigin(origin) || len(request.Header.Values("Origin")) > 1 {
			http.Error(writer, "Forbidden", http.StatusForbidden)
			return
		}
		if origin != "" {
			writer.Header().Set("Access-Control-Allow-Origin", origin)
			writer.Header().Add("Vary", "Origin")
			headers := "Content-Type, X-Dant-Token"
			if auth.mode == "controller" {
				headers += ", " + BackupPassphraseHeader
			}
			writer.Header().Set("Access-Control-Allow-Headers", headers)
			writer.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
		}
		if request.Method == http.MethodOptions {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		isAPI := request.URL.Path == "/api" || strings.HasPrefix(request.URL.Path, "/api/")
		publicSession := request.Method == http.MethodGet && request.URL.Path == "/api/session"
		internal := request.URL.Path == "/api/internal/credentials" && internalCredentialBridge != nil && internalCredentialBridge(request)
		if isAPI && !publicSession && !internal && !auth.CheckToken(request, true) {
			http.Error(writer, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(writer, request)
	})
}
