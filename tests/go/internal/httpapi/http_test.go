package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

func TestReadObjectBoundsAndDuplicateKeys(t *testing.T) {
	for _, test := range []struct {
		body  string
		limit int
		valid bool
	}{
		{`{"text":"原样"}`, 100, true},
		{`{"text":"a","text":"b"}`, 100, false},
		{`{"text":"long"}`, 4, false},
		{`[]`, 100, false},
		{`null`, 100, false},
		{`{} {}`, 100, false},
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/messages", strings.NewReader(test.body))
		object, err := ReadObject(httptest.NewRecorder(), request, test.limit)
		if (err == nil) != test.valid || test.valid && object == nil {
			t.Fatalf("valid=%v err=%v", test.valid, err)
		}
	}
}

func TestHTTPErrorNeverIncludesRawCauses(t *testing.T) {
	writer := httptest.NewRecorder()
	WriteError(writer, errors.New("synthetic SQL /private/path?token=secret"))
	if writer.Code != http.StatusInternalServerError || strings.Contains(writer.Body.String(), "secret") || strings.Contains(writer.Body.String(), "private") {
		t.Fatal("raw cause exposed")
	}

	writer = httptest.NewRecorder()
	WriteError(writer, &store.ProgressError{
		APIError:             &contracts.APIError{Status: 409, Code: "work_progress_conflict", Message: "Confirm removing unfinished work."},
		ConfirmationRequired: true,
	})
	var response errorResponse
	if writer.Code != 409 || json.Unmarshal(writer.Body.Bytes(), &response) != nil || !response.ConfirmationRequired {
		t.Fatal("unfinished-work confirmation contract lost")
	}
}
