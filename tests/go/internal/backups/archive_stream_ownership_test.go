package backups

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type archivePhaseWriter struct {
	bytes.Buffer
	writes int
	after  func(int)
}

func (writer *archivePhaseWriter) Write(data []byte) (int, error) {
	count, err := writer.Buffer.Write(data)
	writer.writes++
	writer.after(writer.writes)
	return count, err
}

func (writer *archivePhaseWriter) WriteString(data string) (int, error) {
	return writer.Write([]byte(data))
}

func TestArchiveStreamRejectsCancellationAndSourceChangesBeforeItsFooter(t *testing.T) {
	for _, mode := range []string{"cancelled", "grown", "linked", "missing-parent"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			parent := filepath.Join(directory, "data")
			if err := os.Mkdir(parent, 0700); err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(parent, "state.json")
			original := bytes.Repeat([]byte{'s'}, 2*ChunkBytes+7)
			if err := os.WriteFile(name, original, 0600); err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256(original)
			archive := ValidatedArchive{
				Directory: directory,
				Manifest: Manifest{
					SchemaVersion: 1, CreatedAt: 1000, AppVersion: "0.4.7", SourceID: "isolated-stream",
					Files: 1, Bytes: int64(len(original)),
				},
				Entries: []ArchiveEntry{{Domain: "data", Path: "state.json", Size: int64(len(original)), SHA256: hex.EncodeToString(hash[:])}},
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			writer := &archivePhaseWriter{after: func(writes int) {
				if writes == 3 {
					if mode == "linked" {
						if err := os.Link(name, filepath.Join(directory, "unowned-link")); err != nil {
							t.Fatal(err)
						}
					} else if mode == "missing-parent" {
						if err := os.Rename(parent, parent+".retained"); err != nil {
							t.Fatal(err)
						}
					}
				}
				if writes == 4 {
					if mode == "cancelled" {
						cancel()
					} else if mode == "grown" {
						file, err := os.OpenFile(name, os.O_WRONLY|os.O_APPEND, 0)
						if err != nil {
							t.Fatal(err)
						}
						_, writeErr := file.Write([]byte("!"))
						closeErr := file.Close()
						if writeErr != nil || closeErr != nil {
							t.Fatal(writeErr, closeErr)
						}
					}
				}
			}}

			err := WriteArchive(ctx, writer, archive)
			wanted := ErrSourceChanged
			if mode == "cancelled" {
				wanted = context.Canceled
			}
			if !errors.Is(err, wanted) || bytes.Contains(writer.Bytes(), []byte(`"type":"footer"`)) {
				t.Fatal("changed source or cancelled stream became a completed archive", err)
			}
			if mode == "missing-parent" {
				name = filepath.Join(parent+".retained", "state.json")
			}
			current, err := os.ReadFile(name)
			if err != nil || len(current) < len(original) || !bytes.Equal(current[:len(original)], original) {
				t.Fatal("failed stream altered or removed its original source", err)
			}
		})
	}
}
