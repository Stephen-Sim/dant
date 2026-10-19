// Package httpapi owns bounded HTTP decoding and safe JSON error responses.
// Feature handlers retain their own validation, identities and authorization.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type Handler func(http.ResponseWriter, *http.Request) error

func Register(mux *http.ServeMux, pattern string, handler Handler) {
	mux.HandleFunc(pattern, func(writer http.ResponseWriter, request *http.Request) {
		if err := handler(writer, request); err != nil {
			WriteError(writer, err)
		}
	})
}

func Failure(status int, code, message string) error {
	return &contracts.APIError{Status: status, Code: code, Message: message}
}

func ReadObject(writer http.ResponseWriter, request *http.Request, limit int) (contracts.RawObject, error) {
	if limit <= 0 {
		limit = config.APIJSONBodyBytes
	}
	if contentType := request.Header.Get("Content-Type"); contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || mediaType != "application/json" {
			return nil, Failure(http.StatusBadRequest, "invalid_json", "Invalid JSON request.")
		}
	}

	body := http.MaxBytesReader(writer, request.Body, int64(limit))
	defer body.Close()
	data, err := io.ReadAll(body)
	if err != nil {
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			return nil, Failure(http.StatusRequestEntityTooLarge, "size_limit", "The request exceeds its size limit.")
		}
		return nil, Failure(http.StatusBadRequest, "invalid_json", "Invalid JSON request.")
	}
	object, err := contracts.DecodeObject(data, limit)
	if err != nil {
		return nil, Failure(http.StatusBadRequest, "invalid_json", "Invalid JSON request.")
	}
	return object, nil
}

func String(object contracts.RawObject, key string, required bool) (string, error) {
	data, present := object[key]
	if !present && !required {
		return "", nil
	}
	var value string
	if !present || string(data) == "null" || json.Unmarshal(data, &value) != nil {
		return "", Failure(http.StatusBadRequest, "invalid_request", "Invalid request fields.")
	}
	return value, nil
}

func Boolean(object contracts.RawObject, key string, fallback bool) (bool, error) {
	data, present := object[key]
	if !present {
		return fallback, nil
	}
	var value bool
	if string(data) == "null" || json.Unmarshal(data, &value) != nil {
		return false, Failure(http.StatusBadRequest, "invalid_request", "Invalid request fields.")
	}
	return value, nil
}

func JSON(writer http.ResponseWriter, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return Failure(http.StatusInternalServerError, "response_invalid", "The response could not be prepared.")
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = writer.Write(data)
	return nil
}

type errorResponse struct {
	Error                string `json:"error"`
	Code                 string `json:"code,omitempty"`
	UnknownOutcome       bool   `json:"unknownOutcome,omitempty"`
	ConfirmationRequired bool   `json:"confirmationRequired,omitempty"`
}

type uncertainOperation interface {
	UnconfirmedOutcome() bool
}

type confirmationFailure interface {
	ConfirmationNeeded() bool
}

func WriteError(writer http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	response := errorResponse{Error: "The operation could not be completed.", Code: "operation_failed"}
	var api *contracts.APIError
	var operation uncertainOperation
	var progress confirmationFailure

	switch {
	case errors.As(err, &api):
		if api.Status >= 400 && api.Status <= 599 {
			status = api.Status
			response.Error, response.Code = api.Message, api.Code
		}
		if errors.As(err, &progress) {
			response.ConfirmationRequired = progress.ConfirmationNeeded()
		}
	case errors.As(err, &operation):
		status = http.StatusBadGateway
		response.UnknownOutcome = operation.UnconfirmedOutcome()
		response.Error, response.Code = "The executor request was not confirmed.", "executor_request_failed"
	}

	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(response)
}
