package backups

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type extractionReadBoundary struct {
	reader io.Reader
	before func()
	eof    func()
}

func (reader *extractionReadBoundary) Read(data []byte) (int, error) {
	if reader.before != nil {
		before := reader.before
		reader.before = nil
		before()
	}
	count, err := reader.reader.Read(data)
	if errors.Is(err, io.EOF) && reader.eof != nil {
		reader.eof()
	}
	return count, err
}

func TestArchiveExtractionRejectsNewPathConflictsWithoutOverwritingTheirContents(t *testing.T) {
	for _, mode := range []string{"parent-file", "existing-file", "existing-directory-target"} {
		t.Run(mode, func(t *testing.T) {
			staging := t.TempDir()
			input := fixtureArchive([]byte("{}"))
			if mode == "existing-directory-target" {
				input = bytes.Replace(input, []byte(`"type":"file"`), []byte(`"type":"directory"`), 1)
				input = bytes.Replace(input, []byte(`"size":2`), []byte(`"size":0`), 1)
			}
			marker := filepath.Join(staging, "data")
			reader := &extractionReadBoundary{reader: bytes.NewReader(input), before: func() {
				if mode == "parent-file" {
					if err := os.Rename(marker, marker+".retained"); err != nil {
						t.Fatal(err)
					}
				} else {
					marker = filepath.Join(marker, "state.json")
				}
				if err := os.WriteFile(marker, []byte("unowned contents"), 0600); err != nil {
					t.Fatal(err)
				}
			}}

			if archive, err := ValidateArchive(t.Context(), reader, staging); !errors.Is(err, ErrInvalid) || archive.Directory != "" {
				t.Fatal("extraction accepted a target that changed after validation", err)
			}
			if current, err := os.ReadFile(marker); err != nil || string(current) != "unowned contents" {
				t.Fatal("rejected extraction overwrote the unowned target", err)
			}
		})
	}
}

func TestArchiveCancellationAtEOFDoesNotConfirmACompletedValidation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	reader := &extractionReadBoundary{reader: bytes.NewReader(fixtureArchive([]byte("{}"))), eof: cancel}
	if archive, err := ValidateArchive(ctx, reader, t.TempDir()); !errors.Is(err, context.Canceled) || archive.Directory != "" {
		t.Fatal("validation confirmed completion after its caller cancelled", err)
	}
}

func TestArchiveRetainsExecutableMetadataAndOriginalBytes(t *testing.T) {
	input := strings.Replace(string(fixtureArchive([]byte("{}"))), `"executable":false`, `"executable":true`, 1)
	archive, err := ValidateArchive(t.Context(), strings.NewReader(input), t.TempDir())
	if err != nil || len(archive.Entries) != 1 || !archive.Entries[0].Executable {
		t.Fatal("archive lost its executable metadata", err)
	}
	var output bytes.Buffer
	if err := WriteArchive(t.Context(), &output, archive); err != nil {
		t.Fatal(err)
	}
	copy, err := ValidateArchive(t.Context(), bytes.NewReader(output.Bytes()), t.TempDir())
	if err != nil || len(copy.Entries) != 1 || copy.Entries[0] != archive.Entries[0] {
		t.Fatal("export and import changed the executable file contract", err)
	}
	if data, err := os.ReadFile(filepath.Join(copy.Directory, "data", "state.json")); err != nil || string(data) != "{}" {
		t.Fatal("export and import changed the executable file contents", err)
	}
}
