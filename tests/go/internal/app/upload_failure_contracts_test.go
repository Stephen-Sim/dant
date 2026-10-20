package app

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

func TestWorkerUploadRejectsDuplicateWrongAndExcessivePartsWithoutSavingFiles(t *testing.T) {
	app := fixtureWorker(t)
	for _, scenario := range []string{"missing", "wrong-field", "duplicate", "parts", "oversized", "truncated"} {
		t.Run(scenario, func(t *testing.T) {
			var buffer bytes.Buffer
			form := multipart.NewWriter(&buffer)
			if scenario == "parts" {
				for range maxUploadParts + 1 {
					if err := form.WriteField("metadata", "fixture"); err != nil {
						t.Fatal(err)
					}
				}
			} else if scenario != "missing" {
				field := "file"
				if scenario == "wrong-field" {
					field = "other"
				}
				part, err := form.CreateFormFile(field, "synthetic.bin")
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "oversized" {
					_, _ = io.CopyN(part, strings.NewReader(strings.Repeat("x", files.MaxAttachmentBytes+1)), int64(files.MaxAttachmentBytes+1))
				} else {
					_, _ = part.Write([]byte("synthetic bytes"))
				}
				if scenario == "duplicate" {
					second, _ := form.CreateFormFile("file", "second.bin")
					_, _ = second.Write([]byte("must not be saved"))
				}
			}
			_ = form.Close()
			data := buffer.Bytes()
			if scenario == "truncated" {
				data = data[:len(data)-12]
			}
			request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:4317/api/upload", bytes.NewReader(data))
			request.Header.Set("X-Dant-Token", app.auth.Info().Token)
			request.Header.Set("Content-Type", form.FormDataContentType())
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			status := 400
			if scenario == "oversized" {
				status = 413
			}
			requireWorkerStatus(t, response, status)
			if len(app.store.Snapshot().Messages) != 0 {
				t.Fatal("invalid upload admitted a message")
			}
		})
	}
	requireWorkerStatus(t, callWorker(app, http.MethodGet, "/api/files/missing", ""), 404)
}

func TestWorkerMultipartReadFailureAndSafeInlineDownloadsPreserveBytes(t *testing.T) {
	app := fixtureWorker(t)
	prefix := "--fixture\r\nContent-Disposition: form-data; name=\"file\"; filename=\"fixture.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n"
	request := httptest.NewRequest(http.MethodPost, "/api/upload", io.MultiReader(strings.NewReader(prefix), appFailedReader{}))
	request.Header.Set("Content-Type", "multipart/form-data; boundary=fixture")
	if _, err := readUpload(httptest.NewRecorder(), request); err == nil {
		t.Fatal("failed multipart reader accepted a partial file")
	}
	image := []byte{137, 80, 78, 71, 13, 10, 26, 10, 1}
	metadata, err := app.attachments.Put(t.Context(), "synthetic.png", "image/png", image)
	if err != nil {
		t.Fatal(err)
	}
	response := callWorker(app, http.MethodGet, "/api/files/"+metadata.ID, "")
	requireWorkerStatus(t, response, 200)
	if !bytes.Equal(response.Body.Bytes(), image) || response.Header().Get("Content-Type") != "image/png" || response.Header().Get("Content-Disposition") != "" {
		t.Fatal("safe image was not served byte-exact inline")
	}
	response = callWorker(app, http.MethodGet, "/api/files/"+metadata.ID+"?download=1", "")
	if response.Header().Get("Content-Disposition") == "" || !bytes.Equal(response.Body.Bytes(), image) {
		t.Fatal("explicit download lost disposition or original bytes")
	}
}
