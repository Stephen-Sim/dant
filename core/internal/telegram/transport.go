package telegram

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"strconv"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

func failureReason(ctx context.Context, err error) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "timeout"
	}
	if ctx.Err() != nil {
		return "cancelled"
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "dns"
	}
	var certificate *tls.CertificateVerificationError
	var unknownCertificate x509.UnknownAuthorityError
	if errors.As(err, &certificate) || errors.As(err, &unknownCertificate) {
		return "tls"
	}
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return "timeout"
	}
	return "network"
}

func responseBytes(response *http.Response, max int64) ([]byte, error) {
	if response == nil || response.Body == nil {
		return nil, &OperationError{Reason: "invalid-response"}
	}
	defer response.Body.Close()
	if response.ContentLength > max {
		return nil, &OperationError{Reason: "response-too-large"}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, &OperationError{Reason: "response-too-large"}
	}
	return data, nil
}

func (gateway *Gateway) api(ctx context.Context, token, method string, body []byte, contentType string) (json.RawMessage, error) {
	switch method {
	case "getMe", "getWebhookInfo", "getUpdates", "getFile", "sendMessage", "sendPhoto", "sendDocument":
	default:
		return nil, ErrConfig
	}
	if !tokenPattern.MatchString(token) {
		return nil, ErrConfig
	}
	outgoing := method == "sendMessage" || method == "sendPhoto" || method == "sendDocument"
	timeout := 30 * time.Second
	if method == "getUpdates" {
		timeout = gateway.options.PollTimeout + 10*time.Second
	}
	bounded, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stop := context.AfterFunc(gateway.ctx, cancel)
	defer stop()
	request, err := http.NewRequestWithContext(bounded, http.MethodPost, apiOrigin+"/bot"+token+"/"+method, bytes.NewReader(body))
	if err != nil {
		return nil, ErrConfig
	}
	if contentType == "" {
		contentType = "application/json"
	}
	request.Header.Set("Content-Type", contentType)
	response, err := gateway.options.HTTP.Do(request)
	if err != nil {
		return nil, &OperationError{Reason: failureReason(bounded, err), Unknown: outgoing}
	}
	data, err := responseBytes(response, MaxResponseBytes)
	if err != nil {
		reason := failureReason(bounded, err)
		var classified *OperationError
		if errors.As(err, &classified) {
			reason = classified.Reason
		}
		return nil, &OperationError{Reason: reason, Unknown: outgoing}
	}
	value, err := contracts.DecodeObject(data, MaxResponseBytes)
	if err != nil {
		return nil, &OperationError{Reason: "invalid-response", Unknown: outgoing}
	}
	var okay bool
	_ = json.Unmarshal(value["ok"], &okay)
	if response.StatusCode >= 500 || response.StatusCode < 200 || response.StatusCode >= 300 || !okay {
		var apiCode int
		_ = json.Unmarshal(value["error_code"], &apiCode)
		if apiCode < 400 {
			apiCode = 0
		}
		code := apiCode
		if response.StatusCode >= 400 {
			code = response.StatusCode
		}
		if apiCode >= 500 {
			code = apiCode
		} else if code < 500 && apiCode == 429 {
			code = 429
		}
		rejected := bytes.Equal(bytes.TrimSpace(value["ok"]), []byte("false")) && apiCode >= 400
		reason := "invalid-response"
		if code >= 500 {
			reason = "server"
		} else if rejected {
			reason = "rejected"
		}
		var retryAfter float64
		var parameters contracts.RawObject
		_ = json.Unmarshal(value["parameters"], &parameters)
		_ = json.Unmarshal(parameters["retry_after"], &retryAfter)
		retry := time.Duration(0)
		if rejected && code == 429 && retryAfter > 0 && retryAfter <= 300 {
			retry = time.Duration(retryAfter * float64(time.Second))
		}
		return nil, &OperationError{Code: code, RetryAfter: retry, Reason: reason, Unknown: outgoing && (!rejected || code >= 500)}
	}
	if outgoing {
		var result contracts.RawObject
		if json.Unmarshal(value["result"], &result) != nil || identifier(result["message_id"]) == "" {
			return nil, &OperationError{Reason: "invalid-response", Unknown: true}
		}
	}
	return bytes.Clone(value["result"]), nil
}

func (gateway *Gateway) verify(ctx context.Context, token string, enabled bool) (*Bot, error) {
	data, err := gateway.api(ctx, token, "getMe", []byte("{}"), "")
	if err != nil {
		return nil, err
	}
	value, err := contracts.DecodeObject(data, MaxResponseBytes)
	var bot bool
	_ = json.Unmarshal(value["is_bot"], &bot)
	name := field(value, "username")
	if err != nil || identifier(value["id"]) == "" || !bot || !botNamePattern.MatchString(name) {
		return nil, ErrConfig
	}
	if enabled {
		data, err = gateway.api(ctx, token, "getWebhookInfo", []byte("{}"), "")
		if err != nil {
			return nil, err
		}
		webhook, err := contracts.DecodeObject(data, MaxResponseBytes)
		if err != nil || field(webhook, "url") != "" {
			return nil, ErrConfig
		}
	}
	return &Bot{ID: identifier(value["id"]), Username: name}, nil
}

func (gateway *Gateway) send(ctx context.Context, token string, items []*OutboxItem, silent bool) (string, string, error) {
	first := items[0]
	if first.Kind == "text" {
		units := []uint16{}
		for index, item := range items {
			if index > 0 {
				units = append(units, '\n', '\n')
			}
			text := raw(item.Text)
			if len(item.legacyText) > 0 && item.Text == item.decodedText {
				text = item.legacyText
			}
			part, err := contracts.DecodeJSONTextUnits(text)
			if err != nil {
				return "", "", &OperationError{Reason: "invalid-response"}
			}
			units = append(units, part...)
		}
		body := object(map[string]any{"chat_id": first.ChatID, "link_preview_options": map[string]bool{"is_disabled": true}})
		body["text"] = contracts.EncodeJSONTextUnits(units)
		if silent {
			body["disable_notification"] = raw(true)
		}
		data, err := gateway.api(ctx, token, "sendMessage", raw(body), "")
		var result contracts.RawObject
		_ = json.Unmarshal(data, &result)
		return identifier(result["message_id"]), "sendMessage", err
	}
	meta, data, err := gateway.options.Attachments.Read(ctx, first.AttachmentID)
	if err != nil {
		return "", "", &OperationError{Reason: "attachment"}
	}
	typeName, err := files.InspectContent(data, meta.Name)
	if err != nil {
		return "", "", &OperationError{Reason: "attachment"}
	}
	method, partName := "sendDocument", "document"
	if !first.DocumentFallback && len(data) <= maxPhotoUploadBytes && (typeName == "image/jpeg" || typeName == "image/png") {
		method, partName = "sendPhoto", "photo"
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("chat_id", first.ChatID)
	if first.Caption != "" {
		_ = writer.WriteField("caption", first.Caption)
	}
	if silent {
		_ = writer.WriteField("disable_notification", "true")
	}
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="`+partName+`"; filename=`+strconv.Quote(meta.Name))
	header.Set("Content-Type", typeName)
	part, err := writer.CreatePart(header)
	if err == nil {
		_, err = part.Write(data)
	}
	if err == nil {
		err = writer.Close()
	}
	if err != nil {
		return "", method, &OperationError{Reason: "attachment"}
	}
	resultData, err := gateway.api(ctx, token, method, body.Bytes(), writer.FormDataContentType())
	var result contracts.RawObject
	_ = json.Unmarshal(resultData, &result)
	return identifier(result["message_id"]), method, err
}
