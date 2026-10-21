package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/skills"
)

func TestWorkerUploadNotifiesAfterDurableBinarySaveAndRejectsInvalidJSONFiles(t *testing.T) {
	app := fixtureWorker(t)
	for _, valid := range []bool{false, true} {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		name := "invalid.json"
		data := []byte("{")
		if valid {
			name = "opaque.data"
			data = []byte{0, 255, 17, 3}
		}
		part, err := form.CreateFormFile("file", name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatal(err)
		}
		if err := form.Close(); err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:4317/api/upload", &body)
		request.Header.Set("Content-Type", form.FormDataContentType())
		request.Header.Set("X-Dant-Token", app.auth.Info().Token)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, request)
		if !valid {
			requireWorkerStatus(t, response, 400)
			if strings.Contains(response.Body.String(), app.options.Startup.DataDir) {
				t.Fatal("attachment save failure exposed its private storage path")
			}
			continue
		}
		requireWorkerStatus(t, response, 200)
		var attachment files.Attachment
		if json.Unmarshal(response.Body.Bytes(), &attachment) != nil || attachment.ID == "" {
			t.Fatal("successful upload omitted its durable attachment identity")
		}
		_, actual, err := app.attachments.Read(t.Context(), attachment.ID)
		if err != nil || !bytes.Equal(actual, data) || len(app.wake) == 0 {
			t.Fatal("successful upload notified before byte-exact persistence", err)
		}
	}
	if len(app.store.Snapshot().Messages) != 0 {
		t.Fatal("upload started a chat message without explicit submission")
	}
}

func TestWorkerUploadDiscardsAnInterruptedNonFileField(t *testing.T) {
	prefix := "--fixture\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n"
	request := httptest.NewRequest(http.MethodPost, "/api/upload", io.MultiReader(strings.NewReader(prefix), appFailedReader{}))
	request.Header.Set("Content-Type", "multipart/form-data; boundary=fixture")
	if _, err := readUpload(httptest.NewRecorder(), request); err == nil {
		t.Fatal("failed non-file form data was accepted as a complete upload")
	}
}

func TestWorkerSnapshotRejectsAnUnconfirmedProtectedKeyWithoutChangingHistory(t *testing.T) {
	app := fixtureWorker(t)
	keys, err := security.NewVoiceKeyStore(app.options.Startup.DataDir, "windows", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	app.voiceKeys = keys
	if err := os.Mkdir(filepath.Join(app.options.Startup.DataDir, security.VoiceKeyFileName), 0700); err != nil {
		t.Fatal(err)
	}
	before := app.store.Revision()
	if snapshot, err := app.Snapshot(t.Context()); err == nil || snapshot.ConversationID != "" {
		t.Fatal("failed secret status was published as a confirmed snapshot")
	}
	if app.store.Revision() != before {
		t.Fatal("failed read-only projection changed chat history")
	}
}

func TestWorkerSkillRefreshDoesNotQueryAfterCallerCancellationOrConversationChange(t *testing.T) {
	app, wire, owner := acknowledgedToolFixture(t)
	before := wire.count("skills/list")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if result := app.refreshSkills(ctx, owner, skills.View{}); result.Refreshed || result.Discovered != nil {
		t.Fatal("cancelled skill discovery invented a confirmed result")
	}
	owner.ConversationID = "retired-conversation"
	if result := app.refreshSkills(t.Context(), owner, skills.View{}); result.Refreshed || result.Discovered != nil {
		t.Fatal("old conversation queried skill discovery through its replacement")
	}
	if wire.count("skills/list") != before {
		t.Fatal("cancelled or stale skill refresh crossed the executor boundary")
	}
}
