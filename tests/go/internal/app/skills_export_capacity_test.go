package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/skills"
)

func TestMaximumSkillZIPFitsAttachmentTransportAndKeeps128UnicodePaths(t *testing.T) {
	fixture := newSkillTransportFixture(t)
	input := skills.SaveInput{Name: strings.Repeat("a", 64), Description: strings.Repeat("d", skills.DescriptionBytes), Instructions: "i", Files: map[string]string{}}
	saved, err := fixture.worker.skills.Save(t.Context(), input, true)
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Dir(saved.Path)
	largeText := []byte(strings.Repeat("界", skills.FileBytes/3) + "ab")
	if len(largeText) != skills.FileBytes {
		t.Fatal("fixture did not reach exact 8MiB single file limit")
	}
	remaining := skills.TotalBytes - 1
	want := map[string][32]byte{}
	for index := range skills.SupportFileLimit {
		relative := "assets/" + strings.Repeat("界", 72) + "/" + strings.Repeat("界", 72) + fmt.Sprintf("%03d", index) + strings.Repeat("a", 21) + ".bin"
		if contracts.UTF16Length(relative) != skills.RelativePathCharacters {
			t.Fatal("fixture path did not reach UTF16 path bound")
		}
		var data []byte
		if index == 0 {
			data = largeText
		} else {
			count := skills.SupportFileLimit - index
			data = make([]byte, (remaining+count-1)/count)
		}
		remaining -= len(data)
		target := filepath.Join(directory, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0600); err != nil {
			t.Fatal(err)
		}
		want[relative] = sha256.Sum256(data)
	}
	if remaining != 0 {
		t.Fatal("fixture did not reach exact 9MiB aggregate")
	}
	response, raw := fixture.request(t, "GET", "/api/skills/"+input.Name, nil)
	var view skills.View
	if response.StatusCode != 200 || json.Unmarshal(raw, &view) != nil || len(view.Files) != 0 || len(view.Assets) != skills.SupportFileLimit {
		t.Fatal("maximum skill leaked asset bodies into editor response")
	}
	patch, _ := json.Marshal(struct {
		Description  string            `json:"description"`
		Instructions string            `json:"instructions"`
		Files        map[string]string `json:"files"`
		Preserve     bool              `json:"preserveBinaryFiles"`
	}{input.Description, "i", map[string]string{}, true})
	response, _ = fixture.request(t, "PATCH", "/api/skills/"+input.Name, patch)
	if response.StatusCode != 200 {
		t.Fatal("maximum skill read-only preservation patch failed")
	}
	for relative, hash := range want {
		data, err := os.ReadFile(filepath.Join(directory, filepath.FromSlash(relative)))
		if err != nil || sha256.Sum256(data) != hash {
			t.Fatal("maximum skill metadata edit changed original support bytes")
		}
	}
	response, raw = fixture.request(t, "POST", "/api/skills/"+input.Name+"/export", []byte(`{}`))
	var attachment contracts.Attachment
	if response.StatusCode != 200 || json.Unmarshal(raw, &attachment) != nil || attachment.ID == "" || !attachment.Size.Present || attachment.Size.Null || attachment.Size.Value <= float64(skills.TotalBytes) || attachment.Size.Value >= float64(skills.ArchiveBytes) || attachment.Size.Value >= float64(files.MaxAttachmentBytes) {
		t.Fatal("maximum ZIP did not fit the real attachment envelope")
	}
	headerBound := (skills.SupportFileLimit+1)*(30+46+2*(64+1+3*skills.RelativePathCharacters)) + 6*skills.DescriptionBytes + 256
	if headerBound >= files.MaxAttachmentBytes-skills.TotalBytes || attachment.Size.Value-float64(skills.TotalBytes) >= float64(headerBound) {
		t.Fatal("maximum ZIP name/header overhead exceeded attachment headroom")
	}
	response, download := fixture.request(t, "GET", "/api/files/"+attachment.ID+"?download=1", nil)
	if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Disposition"), "attachment;") || response.Header.Get("Location") != "" {
		t.Fatal("maximum skill ZIP navigated instead of downloading")
	}
	expected, err := fixture.worker.skills.ExportZIP(t.Context(), input.Name)
	if err != nil || !bytes.Equal(download, expected) || int(attachment.Size.Value) != len(download) {
		t.Fatal("HTTP download changed maximum portable ZIP bytes")
	}
	state, err := fixture.worker.Snapshot(t.Context())
	if err != nil || len(state.Messages) != 0 || state.Active != nil || len(state.WorkTasks) != 0 {
		t.Fatal("maximum skill export created agent work")
	}
}
