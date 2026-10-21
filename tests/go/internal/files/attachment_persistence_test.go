package files

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestAttachmentPersistenceFailureCleansOnlyItsOwnCreatedFiles(t *testing.T) {
	for _, mode := range []string{"id", "create", "content-write", "metadata-write", "replaced-content"} {
		t.Run(mode, func(t *testing.T) {
			store, err := OpenAttachmentStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			if mode == "id" {
				store.newID = func() (uuid.UUID, error) { return uuid.Nil, io.ErrUnexpectedEOF }
			}
			retained := ""
			store.write = func(name string, raw []byte) (fs.FileInfo, error) {
				calls++
				if mode == "create" {
					return nil, io.ErrClosedPipe
				}
				identity, err := writeExclusive(name, raw)
				if err != nil {
					return identity, err
				}
				if mode == "replaced-content" && calls == 1 {
					retained = name + ".retained"
					if err := os.Rename(name, retained); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(name, []byte("unowned replacement"), 0600); err != nil {
						t.Fatal(err)
					}
					return identity, io.ErrClosedPipe
				}
				if (mode == "content-write" && calls == 1) || (mode == "metadata-write" && calls == 2) {
					return identity, io.ErrClosedPipe
				}
				return identity, nil
			}
			if _, err := store.Put(t.Context(), "retained.bin", "", []byte{0, 255, 17}); err == nil {
				t.Fatal("failed attachment write was published")
			}
			entries, err := os.ReadDir(store.Directory())
			if err != nil {
				t.Fatal(err)
			}
			if mode == "replaced-content" {
				raw, err := os.ReadFile(retained)
				if err != nil || !bytes.Equal(raw, []byte{0, 255, 17}) || len(entries) != 2 {
					t.Fatal("failed write removed the original or an unowned replacement")
				}
			} else if len(entries) != 0 {
				t.Fatal("failed attachment retained partially published bytes")
			}
		})
	}
}

func TestAttachmentBase64AndReadFailuresKeepRepositoryBoundaries(t *testing.T) {
	store, err := OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := []byte{0, 255, 17, 128}
	item, err := store.PutBase64(t.Context(), "opaque.bin", "", base64.StdEncoding.EncodeToString(data))
	if err != nil {
		t.Fatal(err)
	}
	_, actual, err := store.Read(t.Context(), item.ID)
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("canonical base64 did not preserve arbitrary file bytes")
	}
	meta := filepath.Join(store.Directory(), item.ID+".json")
	if err := os.Remove(meta); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(meta, 0700); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Read(t.Context(), item.ID); err == nil {
		t.Fatal("metadata repository failure was hidden")
	}
	if _, err := store.Put(t.Context(), "invalid.json", "", []byte("invalid")); !errors.Is(err, ErrAttachment) {
		t.Fatal("invalid JSON was published as a JSON attachment")
	}
	if _, err := store.Get(t.Context(), item.ID); err == nil {
		t.Fatal("metadata directory was treated as a normal file")
	}
}
