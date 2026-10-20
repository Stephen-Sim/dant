package files

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAttachmentsKeepBinaryBytesAndIgnoreUntrustedGuestPaths(t *testing.T) {
	store, err := OpenAttachmentStore(filepath.Join(t.TempDir(), "attachments"))
	if err != nil {
		t.Fatal(err)
	}
	data := []byte{0, 255, 254, 128, 1, 2, 0, 42}
	meta, err := store.Put(context.Background(), `..\folder/数据.bin`, "", data)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "数据.bin" || meta.Type != "application/octet-stream" {
		t.Fatal("attachment name/type not validated")
	}
	_, actual, err := store.Read(context.Background(), meta.ID)
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("binary attachment changed")
	}
	meta.GuestPath = filepath.Join(t.TempDir(), "unrelated-private-file")
	encoded, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Directory(), meta.ID+".json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	readMeta, actual, err := store.Read(context.Background(), meta.ID)
	if err != nil || !bytes.Equal(actual, data) || filepath.Dir(readMeta.GuestPath) != store.Directory() {
		t.Fatal("disk guestPath escaped owned attachment directory")
	}
	if err := os.WriteFile(filepath.Join(store.Directory(), meta.ID+".bin"), []byte{0, 255, 254, 128, 1, 2, 0, 43}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Read(context.Background(), meta.ID); err == nil {
		t.Fatal("changed attachment hash accepted")
	}
}

func TestAttachmentInspectionUsesBytesAndKeepsActiveFormatsDownloads(t *testing.T) {
	for _, fixture := range []struct {
		data           []byte
		name, expected string
	}{
		{[]byte{137, 80, 78, 71, 13, 10, 26, 10}, "image.txt", "image/png"},
		{[]byte("<script>fixture</script>"), "document.html", "application/octet-stream"},
		{[]byte("<svg/>"), "image.svg", "application/octet-stream"},
		{[]byte(`{"fixture":true}`), "data.json", "application/json"},
		{[]byte("文本\n"), "notes.md", "text/plain"},
	} {
		actual, err := InspectContent(fixture.data, fixture.name)
		if err != nil || actual != fixture.expected {
			t.Fatal("content inspection drifted")
		}
	}
	if _, err := InspectContent([]byte{0xff}, "invalid.json"); err == nil {
		t.Fatal("invalid UTF-8 JSON accepted")
	}
	store, err := OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(context.Background(), "image.png", "image/png", []byte("plain text")); err == nil {
		t.Fatal("client media declaration trusted")
	}
	if _, err := store.PutBase64(context.Background(), "text.txt", "", "YQ==\n"); err == nil {
		t.Fatal("noncanonical attachment encoding accepted")
	}
}
