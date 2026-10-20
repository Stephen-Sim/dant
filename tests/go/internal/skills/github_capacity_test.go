package skills

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

type largeGitHubHTTP func(*http.Request) (*http.Response, error)

func (request largeGitHubHTTP) Do(value *http.Request) (*http.Response, error) { return request(value) }

func largeGitBlobSHA(data []byte) string {
	hash := sha1.New()
	_, _ = fmt.Fprintf(hash, "blob %d\x00", len(data))
	_, _ = hash.Write(data)
	return hex.EncodeToString(hash.Sum(nil))
}

func TestGitHubEightMiBBlobAccountsForBase64JSONOverheadAndRetainsExactBytes(t *testing.T) {
	for _, oversized := range []bool{false, true} {
		library := makeLibrary(t)
		input := largeSkillInput()
		manifest := manifestBytes(input.Name, input.Description, input.Instructions)
		content := bytes.Repeat([]byte{255}, FileBytes)
		manifestSHA, contentSHA := largeGitBlobSHA(manifest), largeGitBlobSHA(content)
		commitSHA, treeSHA := strings.Repeat("a", 40), strings.Repeat("b", 40)
		blobs := 0
		fetch := largeGitHubHTTP(func(request *http.Request) (*http.Response, error) {
			if request.Method != "GET" || request.URL.Host != "api.github.com" || request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
				t.Error("skill import crossed the public read-only GitHub boundary")
			}
			var value any
			switch request.URL.Path {
			case "/repos/fixture/project/commits":
				value = []map[string]any{{"sha": commitSHA, "commit": map[string]any{"tree": map[string]string{"sha": treeSHA}}}}
			case "/repos/fixture/project/git/trees/" + treeSHA:
				size := uint64(len(content))
				if oversized {
					size++
				}
				manifestSize := uint64(len(manifest))
				value = gitTree{Truncated: new(bool), Tree: []gitEntry{{Path: "SKILL.md", Type: "blob", Mode: "100644", SHA: manifestSHA, Size: &manifestSize}, {Path: "assets/full.bin", Type: "blob", Mode: "100644", SHA: contentSHA, Size: &size}}}
			case "/repos/fixture/project/git/blobs/" + manifestSHA, "/repos/fixture/project/git/blobs/" + contentSHA:
				blobs++
				data, id := manifest, manifestSHA
				if strings.HasSuffix(request.URL.Path, contentSHA) {
					data, id = content, contentSHA
				}
				encoded := base64.StdEncoding.EncodeToString(data)
				var wrapped strings.Builder
				for len(encoded) > 76 {
					wrapped.WriteString(encoded[:76])
					wrapped.WriteByte('\n')
					encoded = encoded[76:]
				}
				wrapped.WriteString(encoded)
				value = struct {
					Encoding string `json:"encoding"`
					Content  string `json:"content"`
					Size     int    `json:"size"`
					SHA      string `json:"sha"`
				}{"base64", wrapped.String(), len(data), id}
			default:
				t.Fatal("unexpected fixture GitHub route")
			}
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if strings.HasSuffix(request.URL.Path, contentSHA) && (len(raw) <= FileBytes || len(raw) > FileBytes*2) {
				t.Fatal("GitHub fixture did not exercise full base64 JSON overhead")
			}
			return &http.Response{StatusCode: 200, ContentLength: int64(len(raw)), Body: io.NopCloser(bytes.NewReader(raw)), Request: request}, nil
		})
		importer := NewImporter(t.Context(), library, fetch, nil)
		preview, err := importer.Preview(t.Context(), ImportInput{URL: "https://github.com/fixture/project"})
		if oversized {
			assertSkillFailureCode(t, err, "size_limit")
			if blobs != 0 {
				t.Fatal("oversized GitHub tree fetched content before size validation")
			}
		} else {
			if err != nil || len(preview.Files) != 2 || blobs != 2 {
				t.Fatal("maximum GitHub blob was rejected before canonical decoding", err)
			}
			imported, err := importer.Commit(t.Context(), preview.ID, "", nil)
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := library.ExportSnapshot(t.Context(), imported.Name)
			if err != nil {
				t.Fatal(err)
			}
			actual, err := decodeBinary(snapshot.BinaryFiles["assets/full.bin"])
			if err != nil || !bytes.Equal(actual, content) {
				t.Fatal("GitHub maximum blob changed after import")
			}
		}
		importer.Close()
	}
}
