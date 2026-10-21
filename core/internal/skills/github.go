package skills

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

func githubClient() *http.Client {
	return &http.Client{Timeout: ImportDeadline, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func remoteFailure() error {
	return &contracts.APIError{Status: 502, Code: "fetch_failed", Message: "Could not read the public GitHub skill. Check the source or try again later."}
}

func remoteMissing() error {
	return &contracts.APIError{Status: 404, Code: "not_found", Message: "The public GitHub repository, revision, or skill was not found."}
}

var githubOwner = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)
var githubRepository = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
var githubRevision = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
var gitSHA = regexp.MustCompile(`^[a-f0-9]{40}$`)

type revisionCandidate struct{ ref, directory string }

type githubSource struct {
	owner, repository string
	candidates        []revisionCandidate
}

func parseGitHubSource(value string) (githubSource, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return githubSource{}, invalid()
	}
	path := strings.Trim(parsed.EscapedPath(), "/")
	raw := strings.Split(path, "/")
	parts := make([]string, len(raw))
	for index, part := range raw {
		decoded, err := url.PathUnescape(part)
		if err != nil || !utf8.ValidString(decoded) || hasControl(decoded) {
			return githubSource{}, invalid()
		}
		parts[index] = decoded
	}
	if len(parts) < 2 {
		return githubSource{}, invalid()
	}
	owner, repository := parts[0], strings.TrimSuffix(parts[1], ".git")
	if !githubOwner.MatchString(owner) || !githubRepository.MatchString(repository) || repository == "." || repository == ".." {
		return githubSource{}, invalid()
	}
	result := githubSource{owner: owner, repository: repository}
	if len(parts) == 2 {
		result.candidates = []revisionCandidate{{ref: "HEAD"}}
		return result, nil
	}
	if len(parts) < 4 || parts[2] != "tree" && parts[2] != "blob" || !githubRevision.MatchString(parts[3]) || len(parts[3]) > 128 {
		return githubSource{}, invalid()
	}
	ref := parts[3]
	for _, part := range strings.Split(ref, "/") {
		if part == "" || part == "." || part == ".." {
			return githubSource{}, invalid()
		}
	}
	location := parts[4:]
	if parts[2] == "blob" {
		if len(location) == 0 || location[len(location)-1] != "SKILL.md" {
			return githubSource{}, invalid()
		}
		location = location[:len(location)-1]
	}
	if len(location) > MaxDepth {
		return githubSource{}, invalid()
	}
	for _, part := range location {
		if strings.ContainsRune(part, '/') || !safeArchivePath(part) {
			return githubSource{}, invalid()
		}
	}
	for count := len(location); count >= 0; count-- {
		candidate := strings.Join(append([]string{ref}, location[:count]...), "/")
		if len(candidate) <= 128 {
			result.candidates = append(result.candidates, revisionCandidate{ref: candidate, directory: strings.Join(location[count:], "/")})
		}
	}
	return result, nil
}

func (importer *Importer) request(ctx context.Context, route string, limit int, result any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com"+route, nil)
	if err != nil {
		return remoteFailure()
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "dant-skill-import")
	response, err := importer.fetch.Do(request)
	if err != nil {
		return remoteFailure()
	}
	defer response.Body.Close()
	if response.StatusCode == 404 || response.StatusCode == 422 && strings.Contains(route, "/commits?") {
		return remoteMissing()
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || response.Request != nil && response.Request.URL.String() != request.URL.String() {
		return remoteFailure()
	}
	if response.ContentLength > int64(limit) {
		return limited()
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(limit)+1))
	if err != nil {
		return remoteFailure()
	}
	if len(data) > limit {
		return limited()
	}
	if json.Unmarshal(data, result) != nil {
		return remoteFailure()
	}
	return nil
}

type gitEntry struct {
	Path string  `json:"path"`
	Type string  `json:"type"`
	Mode string  `json:"mode"`
	SHA  string  `json:"sha"`
	Size *uint64 `json:"size"`
}

type gitTree struct {
	Truncated *bool      `json:"truncated"`
	Tree      []gitEntry `json:"tree"`
}

func (importer *Importer) tree(ctx context.Context, base, id string, recursive bool) (gitTree, error) {
	var result gitTree
	route := base + "/git/trees/" + id
	if recursive {
		route += "?recursive=1"
	}
	if err := importer.request(ctx, route, ArchiveBytes, &result); err != nil {
		return result, err
	}
	if result.Truncated == nil || *result.Truncated || result.Tree == nil || len(result.Tree) > TreeEntryLimit {
		return result, limited()
	}
	return result, nil
}

func (importer *Importer) github(ctx context.Context, value string) (map[string][]byte, string, error) {
	source, err := parseGitHubSource(value)
	if err != nil {
		return nil, "", err
	}
	base := "/repos/" + url.PathEscape(source.owner) + "/" + url.PathEscape(source.repository)
	type commit struct {
		SHA    string `json:"sha"`
		Commit struct {
			Tree struct {
				SHA string `json:"sha"`
			} `json:"tree"`
		} `json:"commit"`
	}
	var selected commit
	var directory string
	for _, candidate := range source.candidates {
		var commits []commit
		err := importer.request(ctx, base+"/commits?sha="+url.QueryEscape(candidate.ref)+"&per_page=1", FileBytes*2, &commits)
		if err != nil {
			var api *contracts.APIError
			if errors.As(err, &api) && api.Code == "not_found" {
				continue
			}
			return nil, "", err
		}
		if len(commits) != 1 || !gitSHA.MatchString(commits[0].SHA) || !gitSHA.MatchString(commits[0].Commit.Tree.SHA) {
			return nil, "", remoteFailure()
		}
		selected = commits[0]
		directory = candidate.directory
		break
	}
	if selected.SHA == "" {
		return nil, "", remoteMissing()
	}
	treeID := selected.Commit.Tree.SHA
	if directory != "" {
		for _, segment := range strings.Split(directory, "/") {
			tree, err := importer.tree(ctx, base, treeID, false)
			if err != nil {
				return nil, "", err
			}
			found := false
			for _, entry := range tree.Tree {
				if entry.Path == segment {
					if entry.Type != "tree" || entry.Mode != "040000" || !gitSHA.MatchString(entry.SHA) {
						return nil, "", remoteMissing()
					}
					treeID = entry.SHA
					found = true
					break
				}
			}
			if !found {
				return nil, "", remoteMissing()
			}
		}
	}
	tree, err := importer.tree(ctx, base, treeID, true)
	if err != nil {
		return nil, "", err
	}
	entries := map[string]gitEntry{}
	seen := map[string]bool{}
	for _, entry := range tree.Tree {
		if !safeArchivePath(entry.Path) || seen[strings.ToLower(entry.Path)] {
			return nil, "", remoteFailure()
		}
		seen[strings.ToLower(entry.Path)] = true
		if entry.Type == "tree" && entry.Mode == "040000" {
			continue
		}
		entries[entry.Path] = entry
	}
	files, err := selectFiles(entries)
	if err != nil {
		return nil, "", err
	}
	var total uint64
	for _, entry := range files {
		if entry.Type != "blob" || entry.Mode != "100644" && entry.Mode != "100755" || !gitSHA.MatchString(entry.SHA) {
			return nil, "", invalid()
		}
		if entry.Size == nil || *entry.Size > FileBytes {
			return nil, "", limited()
		}
		total += *entry.Size
		if total > TotalBytes+FileBytes {
			return nil, "", limited()
		}
	}
	result := map[string][]byte{}
	for _, name := range sortedNames(files) {
		entry := files[name]
		var blob struct {
			Encoding string  `json:"encoding"`
			Content  string  `json:"content"`
			Size     *uint64 `json:"size"`
			SHA      string  `json:"sha"`
		}
		if err := importer.request(ctx, base+"/git/blobs/"+entry.SHA, FileBytes*2, &blob); err != nil {
			return nil, "", err
		}
		if blob.Encoding != "base64" || blob.Size == nil || *blob.Size != *entry.Size || blob.SHA != entry.SHA {
			return nil, "", remoteFailure()
		}
		encoded := strings.ReplaceAll(blob.Content, "\n", "")
		data, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || strings.ContainsRune(encoded, '\r') || base64.StdEncoding.EncodeToString(data) != encoded || uint64(len(data)) != *entry.Size {
			return nil, "", remoteFailure()
		}
		hash := sha1.New()
		_, _ = io.WriteString(hash, "blob "+strconv.Itoa(len(data))+"\x00")
		_, _ = hash.Write(data)
		if hex.EncodeToString(hash.Sum(nil)) != entry.SHA {
			return nil, "", remoteFailure()
		}
		result[name] = data
	}
	origin := "https://github.com/" + source.owner + "/" + source.repository + "/tree/" + selected.SHA
	if directory != "" {
		for _, segment := range strings.Split(directory, "/") {
			origin += "/" + url.PathEscape(segment)
		}
	}
	return result, origin, nil
}
