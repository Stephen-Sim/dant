package telegram

import (
	"errors"
	"net/http"

	"github.com/Stephen-Sim/dant/core/internal/httpapi"
)

func RegisterRoutes(mux *http.ServeMux, gateway *Gateway) {
	wrap := func(handler httpapi.Handler) httpapi.Handler {
		return func(writer http.ResponseWriter, request *http.Request) error {
			err := handler(writer, request)
			if errors.Is(err, ErrConfig) {
				return httpapi.Failure(400, "telegram_config_invalid", "The Telegram configuration is invalid. Existing pairing was preserved.")
			}
			return err
		}
	}
	httpapi.Register(mux, "GET /api/telegram", func(writer http.ResponseWriter, _ *http.Request) error { return httpapi.JSON(writer, gateway.Status()) })
	httpapi.Register(mux, "POST /api/telegram/config", wrap(func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 4096)
		if err != nil {
			return err
		}
		input, err := ReadConfigure(body)
		if err != nil {
			return err
		}
		status, err := gateway.Configure(request.Context(), input)
		if err != nil {
			return err
		}
		return httpapi.JSON(writer, status)
	}))
	httpapi.Register(mux, "POST /api/telegram/pair", wrap(func(writer http.ResponseWriter, request *http.Request) error {
		result, err := gateway.Pair(request.Context())
		if err != nil {
			return err
		}
		return httpapi.JSON(writer, result)
	}))
	httpapi.Register(mux, "POST /api/telegram/disconnect", wrap(func(writer http.ResponseWriter, request *http.Request) error {
		body, err := httpapi.ReadObject(writer, request, 4096)
		if err != nil {
			return err
		}
		if len(body) > 1 {
			return ErrConfig
		}
		if len(body) == 1 && body["clearToken"] == nil {
			return ErrConfig
		}
		clear, err := httpapi.Boolean(body, "clearToken", false)
		if err != nil {
			return err
		}
		status, err := gateway.Disconnect(request.Context(), clear)
		if err != nil {
			return err
		}
		return httpapi.JSON(writer, status)
	}))
}
