package app

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

func TestFileRoutesPreserveBinaryUploadsAndDownloadDisposition(t *testing.T) {
	storage, err := files.OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registerFileRoutes(mux, storage, nil)
	data := []byte{0, 255, 128, 0, 17, 10}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", "任意格式.custom")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	_ = form.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/upload", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	var metadata files.Attachment
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &metadata) != nil || metadata.ID == "" {
		t.Fatalf("upload: %d %s", response.Code, response.Body.String())
	}

	download := httptest.NewRecorder()
	mux.ServeHTTP(download, httptest.NewRequest(http.MethodGet, "/api/files/"+metadata.ID, nil))
	if download.Code != 200 || !bytes.Equal(download.Body.Bytes(), data) ||
		!strings.HasPrefix(download.Header().Get("Content-Disposition"), "attachment;") ||
		download.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatal("binary download changed or unsafe inline response")
	}
}

func TestFileRoutesRejectMissingMultipartAndUnsupportedActiveMime(t *testing.T) {
	storage, err := files.OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registerFileRoutes(mux, storage, nil)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/upload", strings.NewReader("not multipart")))
	if response.Code != 400 {
		t.Fatal("invalid upload accepted")
	}
	metadata, err := storage.Put(t.Context(), "page.html", "text/html", []byte("<script>parent.alert('fixture')</script>"))
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/files/"+metadata.ID, nil))
	if response.Code != 200 || response.Header().Get("Content-Type") != "application/octet-stream" || response.Header().Get("Content-Disposition") == "" {
		t.Fatal("active HTML served inline")
	}
}
