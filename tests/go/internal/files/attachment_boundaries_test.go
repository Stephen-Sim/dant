package files

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestAttachmentInspectionRecognizesBinarySignaturesAndRejectsInvalidDeclarations(t *testing.T) {
	for _, fixture := range []struct {
		data []byte
		want string
	}{
		{[]byte{255, 216, 255}, "image/jpeg"}, {[]byte("GIF87a"), "image/gif"}, {[]byte("GIF89a"), "image/gif"},
		{[]byte("RIFF0000WEBP"), "image/webp"}, {[]byte("RIFF0000WAVE"), "audio/wav"},
		{[]byte("%PDF-fixture"), "application/pdf"}, {[]byte("OggS"), "audio/ogg"}, {[]byte("ID3"), "audio/mpeg"},
		{[]byte{255, 224}, "audio/mpeg"}, {[]byte{26, 69, 223, 163}, "audio/webm"}, {[]byte{'P', 'K', 3, 4}, "application/zip"},
		{[]byte{'a', 0, 'b'}, "application/octet-stream"}, {[]byte{'a', 11, 'b'}, "application/octet-stream"},
	} {
		if actual, err := InspectContent(fixture.data, "file.bin"); err != nil || actual != fixture.want {
			t.Fatal("binary signature was misclassified", actual, err)
		}
	}
	for _, fixture := range []struct {
		name string
		data []byte
	}{{"bad.json", []byte("{")}, {"too-large", make([]byte, MaxAttachmentBytes+1)}} {
		if _, err := InspectContent(fixture.data, fixture.name); err == nil {
			t.Fatal("invalid attachment contents were accepted")
		}
	}
	store, err := OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, encoded := range []string{"?", "YR==", strings.Repeat("A", ((MaxAttachmentBytes+2)/3)*4+1)} {
		if _, err := store.PutBase64(t.Context(), "fixture.txt", "", encoded); !errors.Is(err, ErrAttachment) {
			t.Fatal("invalid base64 spelling was accepted", err)
		}
	}
	if attachmentName("\x00\x7f.") != "file" || attachmentName("") != "file" || len([]rune(attachmentName(strings.Repeat("😀", 121)))) != 120 {
		t.Fatal("attachment name bounds changed")
	}
}

func TestMalformedAttachmentMetadataNeverSuppliesAFileOrAnExternalPath(t *testing.T) {
	store, err := OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	item, err := store.Put(t.Context(), "fixture.txt", "", []byte("synthetic content"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	for index, fixture := range []string{"[", `{}`, strings.Replace(string(raw), `"name":"fixture.txt"`, `"name":false`, 1), strings.Replace(string(raw), `"size":17`, `"size":null`, 1), strings.Replace(string(raw), `"size":17`, `"size":-1`, 1), strings.Replace(string(raw), `"size":17`, `"size":1.5`, 1), strings.Replace(string(raw), `"id":"`+item.ID+`"`, `"id":"00000000-0000-4000-8000-000000000001"`, 1)} {
		if err := os.WriteFile(filepath.Join(store.Directory(), item.ID+".json"), []byte(fixture), 0o600); err != nil {
			t.Fatal(err)
		}
		if found, err := store.Get(t.Context(), item.ID); err != nil || found != nil {
			t.Fatal("malformed attachment metadata was accepted", index, err)
		}
		if _, _, err := store.Read(t.Context(), item.ID); !errors.Is(err, ErrAttachmentMissing) {
			t.Fatal("malformed metadata supplied file bytes", err)
		}
	}
	item.Size = contracts.Some(float64(1))
	raw, err = json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Directory(), item.ID+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Read(t.Context(), item.ID); !errors.Is(err, ErrFileChanged) {
		t.Fatal("unconfirmed size supplied attachment bytes", err)
	}
	if _, _, err := store.Read(t.Context(), "invalid"); !errors.Is(err, ErrAttachmentMissing) {
		t.Fatal("invalid file identity was accepted", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := store.Put(ctx, "fixture.txt", "", nil); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled attachment was written", err)
	}
	if _, err := store.Get(ctx, item.ID); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled attachment was read", err)
	}
}
