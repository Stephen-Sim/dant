package app

import (
	"bytes"
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/httpapi"
)

const uploadOverheadBytes = 64 * 1024
const maxUploadParts = 16
const uploadFieldBytes = 4096

type uploadFile struct {
	Name string
	Type string
	Data []byte
}

func readUpload(writer http.ResponseWriter, request *http.Request) (uploadFile, error) {
	request.Body = http.MaxBytesReader(writer, request.Body, files.MaxAttachmentBytes+uploadOverheadBytes)
	defer request.Body.Close()
	reader, err := request.MultipartReader()
	if err != nil {
		return uploadFile{}, httpapi.Failure(400, "invalid_upload", "Choose one file to upload.")
	}

	var result uploadFile
	for count := 0; ; count++ {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil || count >= maxUploadParts {
			return uploadFile{}, httpapi.Failure(400, "invalid_upload", "The uploaded file could not be read.")
		}
		if part.FileName() == "" {
			_, err := io.Copy(io.Discard, io.LimitReader(part, uploadFieldBytes+1))
			_ = part.Close()
			if err != nil {
				return uploadFile{}, httpapi.Failure(400, "invalid_upload", "The uploaded file could not be read.")
			}
			continue
		}
		if part.FormName() != "file" || result.Data != nil {
			_ = part.Close()
			return uploadFile{}, httpapi.Failure(400, "invalid_upload", "Choose one file to upload.")
		}

		result.Name = part.FileName()
		result.Type = part.Header.Get("Content-Type")
		result.Data, err = io.ReadAll(io.LimitReader(part, files.MaxAttachmentBytes+1))
		_ = part.Close()
		var oversized *http.MaxBytesError
		if len(result.Data) > files.MaxAttachmentBytes || errors.As(err, &oversized) {
			return uploadFile{}, httpapi.Failure(413, "size_limit", "The uploaded file exceeds its size limit.")
		}
		if err != nil {
			return uploadFile{}, httpapi.Failure(400, "invalid_upload", "The uploaded file could not be read.")
		}
	}
	if result.Data == nil {
		return uploadFile{}, httpapi.Failure(400, "invalid_upload", "Choose one file to upload.")
	}
	return result, nil
}

func registerFileRoutes(mux *http.ServeMux, attachments *files.AttachmentStore, changed func()) {
	httpapi.Register(mux, "POST /api/upload", func(writer http.ResponseWriter, request *http.Request) error {
		input, err := readUpload(writer, request)
		if err != nil {
			return err
		}
		result, err := attachments.Put(request.Context(), input.Name, input.Type, input.Data)
		if err != nil {
			return httpapi.Failure(400, "invalid_attachment", "The uploaded file could not be saved.")
		}
		if changed != nil {
			changed()
		}
		return httpapi.JSON(writer, result)
	})
	httpapi.Register(mux, "GET /api/files/{id}", func(writer http.ResponseWriter, request *http.Request) error {
		metadata, data, err := attachments.Read(request.Context(), request.PathValue("id"))
		if err != nil {
			return httpapi.Failure(404, "attachment_unavailable", "The file is missing, restricted or unavailable.")
		}

		safeInline := slices.Contains([]string{
			"image/png", "image/jpeg", "image/gif", "image/webp",
			"audio/mpeg", "audio/wav", "audio/ogg", "audio/webm",
		}, metadata.Type)
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		if !safeInline || request.URL.Query().Get("download") == "1" {
			writer.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": metadata.Name}))
		}
		if safeInline {
			writer.Header().Set("Content-Type", metadata.Type)
		} else {
			writer.Header().Set("Content-Type", "application/octet-stream")
		}
		http.ServeContent(writer, request, metadata.Name, time.Time{}, bytes.NewReader(data))
		return nil
	})
}
