package security

import (
	"net/http"

	"github.com/Stephen-Sim/dant/core/internal/httpapi"
)

type CredentialReveal struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	Secret         string `json:"secret"`
}

const credentialRevealConversationIDLimit = 128

// RegisterCredentialRevealRoute is mounted behind the Worker's session/origin
// authentication. A reveal is an explicit read, never a vault mutation or event.
func RegisterCredentialRevealRoute(mux *http.ServeMux, credentials *CredentialRequests, conversationID func() string) {
	httpapi.Register(mux, "POST /api/credentials/reveal/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("Pragma", "no-cache")
		writer.Header().Set("X-Content-Type-Options", "nosniff")

		body, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		captured, err := httpapi.String(body, "conversationId", true)
		if err != nil || len(body) != 1 || len(captured) > credentialRevealConversationIDLimit || captured == "" {
			return credentialFailure()
		}
		if conversationID == nil || conversationID() != captured {
			return httpapi.Failure(409, "credential_scope_changed", "The credential view changed. Open it again.")
		}

		credential, err := credentials.Get(request.Context(), request.PathValue("id"))
		if err != nil {
			return credentialFailure()
		}
		defer func() { credential.Secret = "" }()
		if request.Context().Err() != nil || conversationID() != captured {
			return httpapi.Failure(409, "credential_scope_changed", "The credential view changed. Open it again.")
		}
		return httpapi.JSON(writer, CredentialReveal{ID: credential.ID, ConversationID: captured, Secret: credential.Secret})
	})
}
