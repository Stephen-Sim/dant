package skills

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

type skillRouteFixture struct {
	library     *Library
	importer    *Importer
	attachments *files.AttachmentStore
	mux         *http.ServeMux
	online      bool
	reloads     int
}

func newSkillRouteFixture(t *testing.T) *skillRouteFixture {
	t.Helper()
	fixture := &skillRouteFixture{library: makeLibrary(t), online: true}
	fixture.importer = NewImporter(t.Context(), fixture.library, largeGitHubHTTP(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("synthetic unavailable public source")
	}), nil)
	t.Cleanup(func() { _ = fixture.importer.Close() })
	var err error
	fixture.attachments, err = files.OpenAttachmentStore(filepath.Join(t.TempDir(), "attachments"))
	if err != nil {
		t.Fatal(err)
	}
	fixture.mux = http.NewServeMux()
	RegisterRoutes(fixture.mux, RouteOptions{
		Library: fixture.library, Importer: fixture.importer, Attachments: fixture.attachments,
		Online: func() bool { return fixture.online }, Reload: func(context.Context) { fixture.reloads++ },
	})
	return fixture
}

func (fixture *skillRouteFixture) request(t *testing.T, method, route, body string, status int) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, route, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	fixture.mux.ServeHTTP(response, request)
	if response.Code != status {
		t.Fatalf("%s %s: status %d, want %d; %s", method, route, response.Code, status, response.Body.String())
	}
	return response
}

func skillRouteJSON(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestSkillRoutesPreserveAssetsToggleExportAndRemove(t *testing.T) {
	fixture := newSkillRouteFixture(t)
	input := skillInput()
	fixture.request(t, "POST", "/api/skills", skillRouteJSON(t, input), 200)
	fixture.request(t, "GET", "/api/skills", "", 200)
	fixture.request(t, "GET", "/api/skills/test-skill", "", 200)
	fixture.request(t, "PATCH", "/api/skills/test-skill", `{"enabled":false}`, 200)
	fixture.request(t, "PATCH", "/api/skills/test-skill", `{"enabled":false}`, 200)
	fixture.request(t, "PATCH", "/api/skills/test-skill", `{"description":"Edited description","files":{"references/test.txt":"edited"}}`, 200)
	snapshot, err := fixture.library.ExportSnapshot(t.Context(), input.Name)
	if err != nil || snapshot.Enabled || snapshot.Description != "Edited description" || snapshot.Files["references/test.txt"] != "edited" || len(snapshot.BinaryFiles) != 1 {
		t.Fatal("HTTP editing lost preserved data or enablement", err)
	}
	fixture.request(t, "PATCH", "/api/skills/test-skill", `{"instructions":"New instructions","preserveBinaryFiles":true}`, 200)
	exported := fixture.request(t, "POST", "/api/skills/test-skill/export", "{}", 200)
	var attachment files.Attachment
	if err := json.Unmarshal(exported.Body.Bytes(), &attachment); err != nil || attachment.Name != "test-skill.zip" || attachment.Type != "application/zip" {
		t.Fatal("export did not create a ZIP attachment", err)
	}
	fixture.request(t, "DELETE", "/api/skills/test-skill", "", 200)
	fixture.request(t, "GET", "/api/skills/test-skill", "", 404)
	if fixture.reloads != 6 {
		t.Fatalf("successful mutations must reload once each: %d", fixture.reloads)
	}
}

func TestSkillRouteImportPreviewCommitDiscardAndOfflineBoundary(t *testing.T) {
	fixture := newSkillRouteFixture(t)
	preview, err := fixture.importer.Preview(t.Context(), ImportInput{Name: "SKILL.md", Data: manifestBytes("imported", "Imported", "Read the reference.")})
	if err != nil {
		t.Fatal(err)
	}
	fixture.request(t, "POST", "/api/skills/import", skillRouteJSON(t, map[string]any{"id": preview.ID, "name": "renamed", "enabled": false}), 200)
	fixture.request(t, "POST", "/api/skills/import", skillRouteJSON(t, map[string]string{"id": preview.ID}), 410)
	fixture.request(t, "DELETE", "/api/skills/import/previews/absent", "", 200)
	fixture.request(t, "POST", "/api/skills/import/preview", `{"url":"https://github.com/fixture/project"}`, 502)
	fixture.request(t, "POST", "/api/skills/import/preview", `{"url":"http://invalid.example/skill"}`, 400)
	fixture.online = false
	for _, route := range []string{"/api/skills/import", "/api/skills/import/preview", "/api/skills/renamed/export"} {
		fixture.request(t, "POST", route, "{}", 409)
	}
	fixture.request(t, "GET", "/api/skills/renamed", "", 200)
	if fixture.reloads != 1 {
		t.Fatal("read, discard, rejected imports or offline requests reloaded skills")
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, RouteOptions{Library: fixture.library, Importer: fixture.importer, Attachments: fixture.attachments})
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("POST", "/api/skills/renamed/export", nil))
	if response.Code != 409 {
		t.Fatal("missing online owner permitted an export")
	}
}

func TestSkillRoutesRejectInvalidBodiesAndKeepMutationFailuresBounded(t *testing.T) {
	fixture := newSkillRouteFixture(t)
	fixture.request(t, "POST", "/api/skills", skillRouteJSON(t, skillInput()), 200)
	for _, item := range []struct {
		method, route, body string
		status              int
	}{
		{"POST", "/api/skills", `{`, 400},
		{"POST", "/api/skills", `{}`, 400},
		{"POST", "/api/skills", `{"name":"invalid!","description":"x","instructions":"x"}`, 400},
		{"PATCH", "/api/skills/test-skill", `{`, 400},
		{"PATCH", "/api/skills/test-skill", `{"unknown":true}`, 400},
		{"PATCH", "/api/skills/test-skill", `{"enabled":null}`, 400},
		{"PATCH", "/api/skills/test-skill", `{"enabled":"true"}`, 400},
		{"PATCH", "/api/skills/test-skill", `{"description":null}`, 400},
		{"PATCH", "/api/skills/test-skill", `{"description":""}`, 400},
		{"PATCH", "/api/skills/absent", `{"description":"x"}`, 404},
		{"PATCH", "/api/skills/absent", `{"enabled":true}`, 404},
		{"DELETE", "/api/skills/absent", "", 404},
		{"POST", "/api/skills/absent/export", "{}", 404},
		{"POST", "/api/skills/import/preview", `{`, 400},
		{"POST", "/api/skills/import", `{`, 400},
		{"POST", "/api/skills/import", `{"enabled":"yes"}`, 400},
	} {
		fixture.request(t, item.method, item.route, item.body, item.status)
	}
	if fixture.reloads != 1 {
		t.Fatal("rejected mutation reloaded skills")
	}
	if err := os.RemoveAll(fixture.attachments.Directory()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.attachments.Directory(), []byte("synthetic obstruction"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.request(t, "POST", "/api/skills/test-skill/export", "{}", 400)

	if err := os.RemoveAll(fixture.library.enabledRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.library.enabledRoot, []byte("synthetic obstruction"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := fixture.request(t, "GET", "/api/skills", "", 200)
	var snapshot LibrarySnapshot
	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil || snapshot.Error == nil || snapshot.Items == nil {
		t.Fatal("unreadable library did not retain a bounded error snapshot", err)
	}
}

type skillMultipartPart struct{ name, filename, value string }

func multipartSkillRequest(t *testing.T, parts ...skillMultipartPart) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, part := range parts {
		var output io.Writer
		var err error
		if part.filename != "" {
			output, err = writer.CreateFormFile(part.name, part.filename)
		} else {
			output, err = writer.CreateFormField(part.name)
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(output, part.value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/api/skills/import/preview", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func TestSkillMultipartImportAndBoundedInputFailures(t *testing.T) {
	fixture := newSkillRouteFixture(t)
	manifest := string(manifestBytes("multipart", "Multipart", "Read this."))
	request := multipartSkillRequest(t, skillMultipartPart{"file", "SKILL.md", manifest})
	response := httptest.NewRecorder()
	fixture.mux.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal("multipart preview failed", response.Body.String())
	}
	var preview Preview
	if err := json.Unmarshal(response.Body.Bytes(), &preview); err != nil || preview.Name != "multipart" {
		t.Fatal("multipart preview changed the supplied manifest", err)
	}
	fixture.request(t, "DELETE", "/api/skills/import/previews/"+preview.ID, "", 200)
	fixture.request(t, "POST", "/api/skills/import", skillRouteJSON(t, map[string]string{"id": preview.ID}), 410)
	for _, parts := range [][]skillMultipartPart{
		{{"other", "", "x"}},
		{{"url", "", "a"}, {"url", "", "b"}},
		{{"url", "", "a"}, {"file", "SKILL.md", manifest}, {"other", "", "c"}},
		{{"url", "", strings.Repeat("x", sourceURLBytes+1)}},
		{{"file", "skill.zip", strings.Repeat("x", ArchiveBytes+1)}},
	} {
		if _, err := readImportInput(httptest.NewRecorder(), multipartSkillRequest(t, parts...)); err == nil {
			t.Fatal("ambiguous or oversized multipart input accepted")
		}
	}
	for _, item := range []struct{ contentType, body string }{
		{"multipart/form-data", ""},
		{"multipart/form-data; boundary=fixture", "--fixture\r\ninvalid header\r\n\r\n"},
		{"application/json", `{"url":null}`},
		{"application/json", `{"url":true}`},
		{"application/xml", `{}`},
	} {
		request := httptest.NewRequest("POST", "/api/skills/import/preview", strings.NewReader(item.body))
		request.Header.Set("Content-Type", item.contentType)
		if _, err := readImportInput(httptest.NewRecorder(), request); err == nil {
			t.Fatal("invalid multipart/JSON transport accepted", item.contentType)
		}
	}
	request = multipartSkillRequest(t, skillMultipartPart{"url", "", "https://github.com/fixture/project"})
	input, err := readImportInput(httptest.NewRecorder(), request)
	if err != nil || input.URL != "https://github.com/fixture/project" || input.Data != nil {
		t.Fatal("multipart URL input changed", err)
	}
}
