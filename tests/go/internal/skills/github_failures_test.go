package skills

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"
)

type skillResponseBody struct {
	io.Reader
	closed bool
}

func (body *skillResponseBody) Close() error { body.closed = true; return nil }

type skillBrokenReader struct{}

func (skillBrokenReader) Read([]byte) (int, error) { return 0, errors.New("synthetic body failure") }

func TestSkillPublicGitHubRequestRejectsRedirectsErrorsAndOversizedBodies(t *testing.T) {
	for _, item := range []struct {
		name, route, code string
		status            int
		length            int64
		body              io.Reader
		redirect, failure bool
	}{
		{name: "missing", route: "/repo", status: 404, code: "not_found", body: strings.NewReader("")},
		{name: "missing revision", route: "/commits?sha=unknown", status: 422, code: "not_found", body: strings.NewReader("")},
		{name: "unprocessable tree", route: "/git/trees/x", status: 422, code: "fetch_failed", body: strings.NewReader("")},
		{name: "forbidden", status: 403, code: "fetch_failed", body: strings.NewReader("")},
		{name: "redirect", status: 200, code: "fetch_failed", redirect: true, body: strings.NewReader("{}")},
		{name: "declared size", status: 200, code: "size_limit", length: 33, body: strings.NewReader("{}")},
		{name: "streamed size", status: 200, code: "size_limit", body: strings.NewReader(strings.Repeat(" ", 33))},
		{name: "JSON", status: 200, code: "fetch_failed", body: strings.NewReader("invalid JSON")},
		{name: "read failure", status: 200, code: "fetch_failed", body: skillBrokenReader{}},
		{name: "transport", code: "fetch_failed", failure: true},
		{name: "invalid route", route: "\n", code: "fetch_failed"},
	} {
		t.Run(item.name, func(t *testing.T) {
			body := &skillResponseBody{Reader: item.body}
			calls := 0
			importer := NewImporter(t.Context(), makeLibrary(t), largeGitHubHTTP(func(request *http.Request) (*http.Response, error) {
				calls++
				if request.Method != "GET" || request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" || request.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
					t.Error("public read-only request contract changed")
				}
				if item.failure {
					return nil, errors.New("synthetic transport failure")
				}
				response := &http.Response{StatusCode: item.status, ContentLength: item.length, Body: body, Request: request}
				if item.redirect {
					response.Request = &http.Request{URL: &url.URL{Scheme: "https", Host: "other.invalid"}}
				}
				return response, nil
			}), nil)
			defer importer.Close()
			var result map[string]string
			assertSkillFailureCode(t, importer.request(t.Context(), item.route, 32, &result), item.code)
			if item.route == "\n" {
				if calls != 0 {
					t.Fatal("invalid route contacted the transport")
				}
			} else if !item.failure && !body.closed {
				t.Fatal("rejected HTTP response body remained open")
			}
		})
	}
	client := githubClient()
	if !errors.Is(client.CheckRedirect(nil, nil), http.ErrUseLastResponse) || client.Timeout != ImportDeadline {
		t.Fatal("GitHub client followed a redirect or lost its deadline")
	}
}

func TestSkillGitHubSourceValidationAndRevisionDirectoryResolution(t *testing.T) {
	for _, source := range []string{
		"http://github.com/owner/repo", "https://user@github.com/owner/repo", "https://github.com/owner/repo?",
		"https://github.com/owner/repo#fragment", "https://github.com/owner", "https://github.com/-owner/repo",
		"https://github.com/owner/..", "https://github.com/owner/repo/releases/main", "https://github.com/owner/repo/tree/..",
		"https://github.com/owner/repo/tree/a%2F..", "https://github.com/owner/repo/tree/main/a%2Fb",
		"https://github.com/owner/repo/blob/main", "https://github.com/owner/repo/blob/main/README.md",
		"https://github.com/owner/repo/tree/main/" + strings.Repeat("directory/", MaxDepth+1),
		"https://github.com/owner/repo/tree/" + strings.Repeat("a", 129),
		"https://github.com/owner/repo/tree/main/%7f", "https://github.com/owner/repo/tree/main/%ff", "%",
	} {
		if _, err := parseGitHubSource(source); err == nil {
			t.Fatal("unsafe or ambiguous GitHub source accepted")
		}
	}
	source, err := parseGitHubSource("https://github.com/owner/repo.git/blob/feature%2Fx/skills/game/SKILL.md")
	if err != nil || source.repository != "repo" || len(source.candidates) != 3 || source.candidates[2].ref != "feature/x" || source.candidates[2].directory != "skills/game" {
		t.Fatal("branch names containing slashes were not resolved into stable candidates", err)
	}

	manifest := manifestBytes("remote", "Remote skill", "Read this.")
	manifestSHA := largeGitBlobSHA(manifest)
	commitSHA, rootSHA, skillsSHA, gameSHA := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("c", 40), strings.Repeat("d", 40)
	var revisions []string
	importer := NewImporter(t.Context(), makeLibrary(t), largeGitHubHTTP(func(request *http.Request) (*http.Response, error) {
		var value any
		status := 200
		switch request.URL.Path {
		case "/repos/owner/repo/commits":
			ref := request.URL.Query().Get("sha")
			revisions = append(revisions, ref)
			if ref != "feature/x" {
				status, value = 404, map[string]string{}
			} else {
				value = []map[string]any{{"sha": commitSHA, "commit": map[string]any{"tree": map[string]string{"sha": rootSHA}}}}
			}
		case "/repos/owner/repo/git/trees/" + rootSHA:
			value = gitTree{Truncated: new(bool), Tree: []gitEntry{{Path: "other", Type: "blob"}, {Path: "skills", Type: "tree", Mode: "040000", SHA: skillsSHA}}}
		case "/repos/owner/repo/git/trees/" + skillsSHA:
			value = gitTree{Truncated: new(bool), Tree: []gitEntry{{Path: "game", Type: "tree", Mode: "040000", SHA: gameSHA}}}
		case "/repos/owner/repo/git/trees/" + gameSHA:
			if request.URL.Query().Get("recursive") != "1" {
				t.Fatal("final selected tree was not requested recursively")
			}
			value = gitTree{Truncated: new(bool), Tree: []gitEntry{{Path: "assets", Type: "tree", Mode: "040000"}, {Path: "SKILL.md", Type: "blob", Mode: "100755", SHA: manifestSHA, Size: new(uint64(len(manifest)))}}}
		case "/repos/owner/repo/git/blobs/" + manifestSHA:
			value = map[string]any{"encoding": "base64", "content": base64.StdEncoding.EncodeToString(manifest), "size": len(manifest), "sha": manifestSHA}
		default:
			t.Fatal("unexpected synthetic GitHub route")
		}
		return skillGitHubResponse(t, request, status, value), nil
	}), nil)
	defer importer.Close()
	preview, err := importer.Preview(t.Context(), ImportInput{URL: "https://github.com/owner/repo/tree/feature%2Fx/skills/game"})
	if err != nil || preview.Name != "remote" || !strings.Contains(preview.Instructions, "https://github.com/owner/repo/tree/"+commitSHA+"/skills/game") || !slices.Equal(revisions, []string{"feature/x/skills/game", "feature/x/skills", "feature/x"}) {
		t.Fatal("GitHub revision fallback or pinned source provenance changed", err)
	}
}

func skillGitHubResponse(t *testing.T, request *http.Request, status int, value any) *http.Response {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Request: request}
}

func TestSkillGitHubRejectsUnconfirmedTreesBlobsAndRevisionResults(t *testing.T) {
	for _, item := range []struct{ name, code string }{
		{"commit-missing", "not_found"}, {"commit-error", "fetch_failed"}, {"commit-invalid", "fetch_failed"},
		{"tree-error", "fetch_failed"}, {"tree-truncated", "size_limit"}, {"tree-omitted", "size_limit"}, {"tree-too-many", "size_limit"},
		{"nested-error", "fetch_failed"}, {"nested-missing", "not_found"}, {"nested-invalid", "not_found"},
		{"unsafe-path", "fetch_failed"}, {"duplicate-path", "fetch_failed"}, {"missing-manifest", "invalid_skill"},
		{"invalid-kind", "invalid_skill"}, {"invalid-mode", "invalid_skill"}, {"invalid-sha", "invalid_skill"},
		{"omitted-size", "size_limit"}, {"large-file", "size_limit"}, {"large-total", "size_limit"},
		{"blob-error", "fetch_failed"}, {"blob-encoding", "fetch_failed"}, {"blob-size", "fetch_failed"}, {"blob-sha", "fetch_failed"},
		{"blob-base64", "fetch_failed"}, {"blob-carriage", "fetch_failed"}, {"blob-length", "fetch_failed"}, {"blob-hash", "fetch_failed"},
	} {
		t.Run(item.name, func(t *testing.T) {
			manifest := manifestBytes("remote", "Remote", "Read this.")
			manifestSHA := largeGitBlobSHA(manifest)
			commitSHA, treeSHA := strings.Repeat("a", 40), strings.Repeat("b", 40)
			importer := NewImporter(t.Context(), makeLibrary(t), largeGitHubHTTP(func(request *http.Request) (*http.Response, error) {
				var value any
				status := 200
				switch {
				case strings.HasSuffix(request.URL.Path, "/commits"):
					if item.name == "commit-error" {
						return nil, errors.New("synthetic commit lookup failure")
					}
					if item.name == "commit-missing" || strings.HasPrefix(item.name, "nested-") && request.URL.Query().Get("sha") != "main" {
						return skillGitHubResponse(t, request, 404, map[string]string{}), nil
					}
					id := commitSHA
					if item.name == "commit-invalid" {
						id = "not-a-sha"
					}
					value = []map[string]any{{"sha": id, "commit": map[string]any{"tree": map[string]string{"sha": treeSHA}}}}
				case strings.Contains(request.URL.Path, "/git/trees/"):
					entry := gitEntry{Path: "SKILL.md", Type: "blob", Mode: "100644", SHA: manifestSHA, Size: new(uint64(len(manifest)))}
					tree := gitTree{Truncated: new(bool), Tree: []gitEntry{entry}}
					switch item.name {
					case "tree-error", "nested-error":
						status = 503
					case "tree-truncated":
						tree.Truncated = new(true)
					case "tree-omitted":
						tree.Tree = nil
					case "tree-too-many":
						tree.Tree = make([]gitEntry, TreeEntryLimit+1)
					case "nested-missing":
						tree.Tree = []gitEntry{}
					case "nested-invalid":
						entry.Path = "folder"
						tree.Tree = []gitEntry{entry}
					case "unsafe-path":
						entry.Path = "../SKILL.md"
						tree.Tree = []gitEntry{entry}
					case "duplicate-path":
						tree.Tree = []gitEntry{entry, entry}
					case "missing-manifest":
						tree.Tree = []gitEntry{}
					case "invalid-kind":
						entry.Type = "commit"
						tree.Tree = []gitEntry{entry}
					case "invalid-mode":
						entry.Mode = "120000"
						tree.Tree = []gitEntry{entry}
					case "invalid-sha":
						entry.SHA = "unknown"
						tree.Tree = []gitEntry{entry}
					case "omitted-size":
						entry.Size = nil
						tree.Tree = []gitEntry{entry}
					case "large-file":
						entry.Size = new(uint64(FileBytes + 1))
						tree.Tree = []gitEntry{entry}
					case "large-total":
						entry.Size = new(uint64(FileBytes))
						tree.Tree = []gitEntry{entry}
						for _, name := range []string{"assets/a", "assets/b"} {
							entry.Path = name
							tree.Tree = append(tree.Tree, entry)
						}
					}
					value = tree
				case strings.Contains(request.URL.Path, "/git/blobs/"):
					blob := map[string]any{"encoding": "base64", "content": base64.StdEncoding.EncodeToString(manifest), "size": len(manifest), "sha": manifestSHA}
					switch item.name {
					case "blob-error":
						status = 503
					case "blob-encoding":
						blob["encoding"] = "hex"
					case "blob-size":
						blob["size"] = nil
					case "blob-sha":
						blob["sha"] = treeSHA
					case "blob-base64":
						blob["content"] = "not base64!"
					case "blob-carriage":
						blob["content"] = base64.StdEncoding.EncodeToString(manifest) + "\r"
					case "blob-length":
						blob["content"] = base64.StdEncoding.EncodeToString([]byte("short"))
					case "blob-hash":
						changed := append([]byte(nil), manifest...)
						changed[len(changed)-1] ^= 1
						blob["content"] = base64.StdEncoding.EncodeToString(changed)
					}
					value = blob
				default:
					t.Fatal("unexpected synthetic request")
				}
				return skillGitHubResponse(t, request, status, value), nil
			}), nil)
			defer importer.Close()
			source := "https://github.com/fixture/project"
			if strings.HasPrefix(item.name, "nested-") {
				source += "/tree/main/folder"
			}
			_, _, err := importer.github(t.Context(), source)
			assertSkillFailureCode(t, err, item.code)
		})
	}
}
