package skills

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/httpapi"
)

const multipartOverheadBytes = 64 * 1024
const sourceURLBytes = 2048

type RouteOptions struct {
	Library     *Library
	Importer    *Importer
	Attachments *files.AttachmentStore
	Online      func() bool
	Reload      func(context.Context)
}

type LibrarySnapshot struct {
	Items []Summary `json:"items"`
	Error *string   `json:"error,omitempty"`
}

func (library *Library) Snapshot(ctx context.Context) LibrarySnapshot {
	items, err := library.List(ctx)
	if err != nil {
		message := "Managed skills could not be read. Existing files were preserved."
		return LibrarySnapshot{Items: []Summary{}, Error: &message}
	}
	return LibrarySnapshot{Items: items}
}

func skillHTTPError(err error) error {
	var api *contracts.APIError
	if errors.As(err, &api) {
		return err
	}
	return invalid()
}

func RegisterRoutes(mux *http.ServeMux, options RouteOptions) {
	reload := func(ctx context.Context) {
		if options.Reload != nil {
			options.Reload(ctx)
		}
	}
	requireOnline := func() error {
		if options.Online == nil || !options.Online() {
			return httpapi.Failure(409, "import_busy", "Connect the work computer before managing skills.")
		}
		return nil
	}

	httpapi.Register(mux, "GET /api/skills", func(writer http.ResponseWriter, request *http.Request) error {
		return httpapi.JSON(writer, options.Library.Snapshot(request.Context()))
	})
	httpapi.Register(mux, "GET /api/skills/{name}", func(writer http.ResponseWriter, request *http.Request) error {
		result, err := options.Library.Get(request.Context(), request.PathValue("name"))
		if err != nil {
			return skillHTTPError(err)
		}
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "POST /api/skills", func(writer http.ResponseWriter, request *http.Request) error {
		object, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		encoded, _ := json.Marshal(object)
		input, err := DecodeSave(encoded)
		if err != nil {
			return err
		}
		result, err := options.Library.Save(request.Context(), input, true)
		if err != nil {
			return skillHTTPError(err)
		}
		reload(request.Context())
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "PATCH /api/skills/{name}", func(writer http.ResponseWriter, request *http.Request) error {
		object, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		for key := range object {
			if !slices.Contains([]string{"description", "instructions", "files", "enabled", "preserveBinaryFiles"}, key) {
				return invalid()
			}
		}
		name := request.PathValue("name")
		if enabled, ok := object["enabled"]; ok && len(object) == 1 {
			var value bool
			if string(enabled) == "null" || json.Unmarshal(enabled, &value) != nil {
				return invalid()
			}
			result, err := options.Library.SetEnabled(request.Context(), name, value)
			if err != nil {
				return skillHTTPError(err)
			}
			reload(request.Context())
			return httpapi.JSON(writer, result)
		}

		current, err := options.Library.Get(request.Context(), name)
		if err != nil {
			return skillHTTPError(err)
		}
		encoded, _ := json.Marshal(current)
		var merged contracts.RawObject
		_ = json.Unmarshal(encoded, &merged)
		for key, value := range object {
			merged[key] = value
		}
		merged["name"], _ = json.Marshal(name)
		if _, present := object["preserveBinaryFiles"]; !present {
			merged["preserveBinaryFiles"] = json.RawMessage("true")
		}
		encoded, _ = json.Marshal(merged)
		input, err := DecodeSave(encoded)
		if err != nil {
			return err
		}
		result, err := options.Library.Save(request.Context(), input, true)
		if err != nil {
			return skillHTTPError(err)
		}
		reload(request.Context())
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "DELETE /api/skills/{name}", func(writer http.ResponseWriter, request *http.Request) error {
		name := request.PathValue("name")
		if err := options.Library.Remove(request.Context(), name); err != nil {
			return skillHTTPError(err)
		}
		reload(request.Context())
		return httpapi.JSON(writer, struct {
			Removed bool   `json:"removed"`
			Name    string `json:"name"`
		}{true, name})
	})

	httpapi.Register(mux, "POST /api/skills/{name}/export", func(writer http.ResponseWriter, request *http.Request) error {
		if err := requireOnline(); err != nil {
			return err
		}
		name := request.PathValue("name")
		data, err := options.Library.ExportZIP(request.Context(), name)
		if err != nil {
			return skillHTTPError(err)
		}
		attachment, err := options.Attachments.Put(request.Context(), name+".zip", "application/zip", data)
		if err != nil {
			return skillHTTPError(err)
		}
		return httpapi.JSON(writer, attachment)
	})
	httpapi.Register(mux, "POST /api/skills/import/preview", func(writer http.ResponseWriter, request *http.Request) error {
		if err := requireOnline(); err != nil {
			return err
		}
		input, err := readImportInput(writer, request)
		if err != nil {
			return err
		}
		result, err := options.Importer.Preview(request.Context(), input)
		if err != nil {
			return skillHTTPError(err)
		}
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "POST /api/skills/import", func(writer http.ResponseWriter, request *http.Request) error {
		if err := requireOnline(); err != nil {
			return err
		}
		object, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return err
		}
		var input struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Enabled *bool  `json:"enabled"`
		}
		encoded, _ := json.Marshal(object)
		if !contracts.ValidUnicodeJSON(encoded) || json.Unmarshal(encoded, &input) != nil {
			return invalid()
		}
		result, err := options.Importer.Commit(request.Context(), input.ID, input.Name, input.Enabled)
		if err != nil {
			return skillHTTPError(err)
		}
		reload(request.Context())
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "DELETE /api/skills/import/previews/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		options.Importer.Discard(request.PathValue("id"))
		return httpapi.JSON(writer, struct {
			Discarded bool `json:"discarded"`
		}{true})
	})
}

func readImportInput(writer http.ResponseWriter, request *http.Request) (ImportInput, error) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		object, err := httpapi.ReadObject(writer, request, 0)
		if err != nil {
			return ImportInput{}, err
		}
		value, err := httpapi.String(object, "url", true)
		return ImportInput{URL: value}, err
	}
	request.Body = http.MaxBytesReader(writer, request.Body, ArchiveBytes+multipartOverheadBytes)
	defer request.Body.Close()
	reader, err := request.MultipartReader()
	if err != nil {
		return ImportInput{}, invalid()
	}

	input := ImportInput{}
	seen := map[string]bool{}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return ImportInput{}, invalid()
		}
		name := part.FormName()
		if seen[name] || len(seen) >= 2 || (name != "file" && name != "url") {
			_ = part.Close()
			return ImportInput{}, invalid()
		}
		seen[name] = true
		limit := ArchiveBytes
		if name == "url" {
			limit = sourceURLBytes
		}
		data, err := io.ReadAll(io.LimitReader(part, int64(limit)+1))
		_ = part.Close()
		if err != nil || len(data) > limit {
			return ImportInput{}, limited()
		}
		if name == "file" {
			input.Name, input.Data = part.FileName(), data
		} else {
			input.URL = string(data)
		}
	}
	return input, nil
}
