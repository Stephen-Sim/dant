package voice

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/coder/websocket"
)

var remoteCallID = regexp.MustCompile(`^/v1/realtime/calls/(rtc_[a-zA-Z0-9_-]+)/?$`)
var audioSDPLine = regexp.MustCompile(`(?m)^m=audio `)

func validSDP(value string) bool {
	return utf8.ValidString(value) && contracts.UTF16Length(value) <= 200000 && strings.HasPrefix(strings.ReplaceAll(value, "\r\n", "\n"), "v=0\n") && audioSDPLine.MatchString(value)
}

func defaultVoiceHTTP() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

type apiSocket struct{ connection *websocket.Conn }

func (socket apiSocket) Read(ctx context.Context) ([]byte, error) {
	kind, data, err := socket.connection.Read(ctx)
	if err != nil {
		return nil, err
	}
	if kind != websocket.MessageText {
		return nil, ErrVoiceConnection
	}
	return data, nil
}

func (socket apiSocket) Write(ctx context.Context, data []byte) error {
	return socket.connection.Write(ctx, websocket.MessageText, data)
}

func (socket apiSocket) Close() error { return socket.connection.CloseNow() }
func dialVoice(ctx context.Context, address, key string) (VoiceSocket, error) {
	connection, response, err := websocket.Dial(ctx, address, &websocket.DialOptions{HTTPClient: defaultVoiceHTTP(), HTTPHeader: http.Header{"Authorization": []string{"Bearer " + key}}, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		return nil, ErrVoiceConnection
	}
	connection.SetReadLimit(maxVoiceEventBytes)
	return apiSocket{connection}, nil
}

func remoteID(response *http.Response) string {
	base, _ := url.Parse(voiceAPI)
	location, err := base.Parse(response.Header.Get("Location"))
	if err != nil || location.Scheme != "https" || location.Host != "api.openai.com" || location.RawQuery != "" || location.User != nil {
		return ""
	}
	match := remoteCallID.FindStringSubmatch(location.Path)
	if len(match) != 2 {
		return ""
	}
	return match[1]
}

func (api *API) createCall(ctx context.Context, s *apiSession, offer string) (string, error) {
	api.mu.Lock()
	voice, key, instructions := s.voice, s.key, s.baseInstructions
	api.mu.Unlock()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	if err := form.WriteField("sdp", offer); err != nil {
		return "", ErrVoiceConnection
	}
	session := object(map[string]any{"type": "realtime", "model": api.options.Model, "output_modalities": []string{"audio"}, "audio": map[string]any{"input": map[string]any{"transcription": map[string]any{"model": "gpt-transcribe"}, "turn_detection": map[string]any{"type": "server_vad", "create_response": true, "interrupt_response": true}}, "output": map[string]any{"voice": voice}}, "instructions": instructions, "tools": VoiceTools(), "tool_choice": "auto"})
	if err := form.WriteField("session", string(rawValue(session))); err != nil {
		return "", ErrVoiceConnection
	}
	if err := form.Close(); err != nil {
		return "", ErrVoiceConnection
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, voiceAPI, &body)
	if err != nil {
		return "", ErrVoiceConnection
	}
	request.Header.Set("Content-Type", form.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+key)
	response, err := api.options.HTTP.Do(request)
	if err != nil {
		return "", ErrVoiceConnection
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", voiceHTTPError(response.StatusCode)
	}
	id := remoteID(response)
	if id == "" {
		return "", ErrVoiceConnection
	}
	api.mu.Lock()
	s.id = id
	current := api.session == s && !s.closed && !s.stopping
	api.mu.Unlock()
	if !current {
		_ = api.hangupRemote(id, key)
		return "", ErrVoiceCancelled
	}
	answer, err := io.ReadAll(io.LimitReader(response.Body, 800001))
	if err != nil || !validSDP(string(answer)) {
		return "", ErrVoiceConnection
	}
	return string(answer), nil
}

func (api *API) hangup(s *apiSession) error {
	api.mu.Lock()
	id, key := s.id, s.key
	api.mu.Unlock()
	if id == "" || key == "" {
		return nil
	}
	return api.hangupRemote(id, key)
}

func (api *API) hangupRemote(id, key string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(api.ctx), api.options.HangupTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, voiceAPI+"/"+url.PathEscape(id)+"/hangup", nil)
	if err != nil {
		return ErrVoiceHangup
	}
	request.Header.Set("Authorization", "Bearer "+key)
	response, err := api.options.HTTP.Do(request)
	if err != nil {
		return ErrVoiceHangup
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 || response.StatusCode == 404 || response.StatusCode == 410 {
		return nil
	}
	return ErrVoiceHangup
}

func voiceHTTPError(status int) error {
	switch status {
	case 401:
		return errors.New("voice_api_key_rejected")
	case 403:
		return errors.New("voice_model_access_denied")
	case 404:
		return errors.New("voice_model_unavailable")
	case 429:
		return errors.New("voice_rate_limited")
	}
	return ErrVoiceConnection
}
