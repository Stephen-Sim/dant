package security

import (
	"encoding/json"
	"net/http"

	"github.com/Stephen-Sim/dant/core/internal/httpapi"
)

func credentialFailure() error {
	return httpapi.Failure(400, "credential_action_failed", "The credential action could not be completed. Existing data was preserved.")
}

func readCredential(writer http.ResponseWriter, request *http.Request, id string) (CredentialInput, error) {
	object, err := httpapi.ReadObject(writer, request, 0)
	if err != nil {
		return CredentialInput{}, err
	}
	if id != "" {
		object["id"], _ = json.Marshal(id)
	}
	data, _ := json.Marshal(object)
	var input CredentialInput
	if json.Unmarshal(data, &input) != nil {
		return input, credentialFailure()
	}
	return input, nil
}

func RegisterCredentialRoutes(mux *http.ServeMux, credentials *CredentialRequests) {
	httpapi.Register(mux, "GET /api/credentials", func(writer http.ResponseWriter, request *http.Request) error {
		return httpapi.JSON(writer, credentials.Snapshot(request.Context()))
	})
	upsert := func(writer http.ResponseWriter, request *http.Request) error {
		input, err := readCredential(writer, request, request.PathValue("id"))
		if err != nil {
			return err
		}
		result, err := credentials.Upsert(request.Context(), input)
		if err != nil {
			return credentialFailure()
		}
		return httpapi.JSON(writer, result)
	}
	httpapi.Register(mux, "POST /api/credentials", upsert)
	httpapi.Register(mux, "PATCH /api/credentials/{id}", upsert)
	httpapi.Register(mux, "DELETE /api/credentials/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		result, err := credentials.Remove(request.Context(), request.PathValue("id"))
		if err != nil {
			return credentialFailure()
		}
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "POST /api/credentials/requests/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		input, err := readCredential(writer, request, "")
		if err != nil {
			return err
		}
		result, err := credentials.Fulfill(request.Context(), request.PathValue("id"), input)
		if err != nil {
			return credentialFailure()
		}
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "DELETE /api/credentials/requests/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		result, err := credentials.Cancel(request.PathValue("id"))
		if err != nil {
			return credentialFailure()
		}
		return httpapi.JSON(writer, result)
	})
}
