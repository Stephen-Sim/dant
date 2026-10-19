package skills

import (
	"context"
	"encoding/base64"
	"errors"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/google/uuid"
)

type ImportInput struct {
	URL  string
	Name string
	Data []byte
}

type ImportFile struct {
	Path string `json:"path"`
	Size int    `json:"size"`
}

type Preview struct {
	ID           string       `json:"id"`
	Source       string       `json:"source"`
	Name         string       `json:"name"`
	Description  string       `json:"description"`
	Instructions string       `json:"instructions"`
	Files        []ImportFile `json:"files"`
	ExpiresAt    float64      `json:"expiresAt"`
}

type importPreview struct {
	value   SaveInput
	expires time.Time
}

type Importer struct {
	library  *Library
	fetch    HTTPDoer
	now      func() time.Time
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	closed   bool
	inflight int
	previews map[string]importPreview
	workers  sync.WaitGroup
}

func NewImporter(ctx context.Context, library *Library, fetch HTTPDoer, now func() time.Time) *Importer {
	if now == nil {
		now = time.Now
	}
	if fetch == nil {
		fetch = githubClient()
	}
	lifetime, cancel := context.WithCancel(ctx)
	return &Importer{library: library, fetch: fetch, now: now, ctx: lifetime, cancel: cancel, previews: map[string]importPreview{}}
}

func (importer *Importer) cleanLocked() {
	for id, item := range importer.previews {
		if !item.expires.After(importer.now()) {
			delete(importer.previews, id)
		}
	}
}

func expired() error {
	return &contracts.APIError{Status: 410, Code: "expired", Message: "This import preview expired or was already used. Preview the source again."}
}

func (importer *Importer) Preview(ctx context.Context, input ImportInput) (Preview, error) {
	importer.mu.Lock()
	importer.cleanLocked()
	if importer.closed {
		importer.mu.Unlock()
		return Preview{}, expired()
	}
	if len(importer.previews)+importer.inflight >= MaxPreviews {
		importer.mu.Unlock()
		return Preview{}, &contracts.APIError{Status: 429, Code: "import_busy", Message: "Three import previews are already open. Finish one or wait for it to expire."}
	}
	if (input.URL != "") == (input.Data != nil) {
		importer.mu.Unlock()
		return Preview{}, invalid()
	}
	importer.inflight++
	importer.workers.Add(1)
	importer.mu.Unlock()
	defer func() { importer.mu.Lock(); importer.inflight--; importer.mu.Unlock(); importer.workers.Done() }()
	deadline, cancel := context.WithTimeout(ctx, ImportDeadline)
	defer cancel()
	stop := context.AfterFunc(importer.ctx, cancel)
	defer stop()
	var data map[string][]byte
	var source string
	var err error
	if input.URL != "" {
		data, source, err = importer.github(deadline, input.URL)
	} else {
		if len(input.Data) > ArchiveBytes {
			return Preview{}, limited()
		}
		source = path.Base(strings.ReplaceAll(input.Name, "\\", "/"))
		if hasControl(source) || contracts.UTF16Length(source) > RelativePathCharacters {
			return Preview{}, invalid()
		}
		if source == "SKILL.md" {
			if len(input.Data) > FileBytes {
				return Preview{}, limited()
			}
			data = map[string][]byte{"SKILL.md": input.Data}
		} else if strings.EqualFold(path.Ext(source), ".zip") {
			data, err = readZIP(deadline, input.Data)
		} else {
			return Preview{}, invalid()
		}
	}
	if err != nil {
		return Preview{}, err
	}
	manifest, ok := data["SKILL.md"]
	if !ok {
		return Preview{}, invalid()
	}
	candidate, err := parseManifest(manifest, source)
	if err != nil {
		return Preview{}, err
	}
	candidate.Files = map[string]string{}
	candidate.BinaryFiles = map[string]BinaryFile{}
	listed := []ImportFile{{Path: "SKILL.md", Size: len(manifest)}}
	total := len(candidate.Instructions)
	for _, name := range sortedNames(data) {
		if name == "SKILL.md" {
			continue
		}
		value := data[name]
		if !ValidFileName(name) {
			return Preview{}, invalid()
		}
		if len(value) > FileBytes {
			return Preview{}, limited()
		}
		total += len(value)
		if total > TotalBytes {
			return Preview{}, limited()
		}
		if importer.library.secret(deadline, value) || importer.library.secret(deadline, []byte(name)) {
			return Preview{}, credentials()
		}
		if textFile(value) {
			candidate.Files[name] = string(value)
		} else {
			candidate.BinaryFiles[name] = BinaryFile{Encoding: "base64", MediaType: "application/octet-stream", Data: base64.StdEncoding.EncodeToString(value)}
		}
		listed = append(listed, ImportFile{Path: name, Size: len(value)})
	}
	if len(data) > SupportFileLimit+1 {
		return Preview{}, limited()
	}
	for _, value := range []string{candidate.Name, candidate.Description, candidate.Instructions} {
		if importer.library.secret(deadline, []byte(value)) {
			return Preview{}, credentials()
		}
	}
	if err := deadline.Err(); err != nil {
		return Preview{}, err
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return Preview{}, invalid()
	}
	expires := importer.now().Add(PreviewLifetime)
	importer.mu.Lock()
	defer importer.mu.Unlock()
	if importer.closed || deadline.Err() != nil {
		return Preview{}, expired()
	}
	importer.previews[id.String()] = importPreview{value: candidate, expires: expires}
	return Preview{
		ID:           id.String(),
		Source:       source,
		Name:         candidate.Name,
		Description:  candidate.Description,
		Instructions: candidate.Instructions,
		Files:        listed,
		ExpiresAt:    float64(expires.UnixMilli()),
	}, nil
}

func (importer *Importer) Commit(ctx context.Context, id, name string, enabled *bool) (View, error) {
	importer.mu.Lock()
	importer.cleanLocked()
	item, ok := importer.previews[id]
	if !ok || importer.closed {
		importer.mu.Unlock()
		return View{}, expired()
	}
	if name == "" {
		name = item.value.Name
	}
	if !namePattern.MatchString(name) {
		importer.mu.Unlock()
		return View{}, invalid()
	}
	// Consume once before writing; a failed write is not silently retried.
	delete(importer.previews, id)
	importer.workers.Add(1)
	importer.mu.Unlock()
	defer importer.workers.Done()
	item.value.Name = name
	item.value.Enabled = enabled
	result, err := importer.library.Save(ctx, item.value, false)
	if err != nil {
		var api *contracts.APIError
		if errors.As(err, &api) && api.Code == "name_exists" {
			return View{}, err
		}
		return View{}, invalid()
	}
	return result, nil
}

func (importer *Importer) Discard(id string) {
	importer.mu.Lock()
	delete(importer.previews, id)
	importer.mu.Unlock()
}

func (importer *Importer) Close() error {
	importer.mu.Lock()
	importer.closed = true
	clear(importer.previews)
	importer.cancel()
	importer.mu.Unlock()
	importer.workers.Wait()
	return nil
}
