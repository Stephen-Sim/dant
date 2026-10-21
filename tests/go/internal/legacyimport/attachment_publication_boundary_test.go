package legacyimport

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAttachmentPublicationFailureRetainsUnconfirmedBytesWithoutMappingOrReplay(t *testing.T) {
	for _, extension := range []string{".bin", ".json"} {
		for _, phase := range []string{"write", "short-write", "sync", "close"} {
			t.Run(extension+"/"+phase, func(t *testing.T) {
				options, value, target, owner := importPublicationFixture(t)
				journal := []byte(`{"id":"retained unconfirmed import attempt"}`)
				if err := target.exclusive(t.Context(), journalName, journal); err != nil {
					t.Fatal(err)
				}
				if err := target.root.Mkdir("attachments", 0700); err != nil {
					t.Fatal(err)
				}
				directory := filepath.Join(options.TargetDir, "attachments")
				attachments, err := openDestination(directory)
				if err != nil {
					t.Fatal(err)
				}
				defer attachments.close()
				create := attachments.create
				var captured *interruptedPublicationFile
				created := []string{}
				attachments.create = func(name string) (publicationFile, error) {
					created = append(created, name)
					opened, err := create(name)
					if err != nil || !strings.HasSuffix(name, extension) {
						return opened, err
					}
					captured = &interruptedPublicationFile{
						publicationFile: opened, phase: phase,
						privateFail: errors.New("isolated attachment publication failure"),
					}
					return captured, nil
				}

				mapped, archived, warnings, err := value.archiveFiles(t.Context(), attachments, options.TargetDir)
				if !errors.Is(err, ErrUnconfirmed) || mapped != nil || archived != nil || warnings != nil || captured == nil || captured.closeCalls != 1 {
					t.Fatal("interrupted attachment acquired a mapping or repeated its close", err)
				}
				wantFiles := 1
				if extension == ".json" {
					wantFiles = 2
				}
				if len(created) != wantFiles || !strings.HasSuffix(created[len(created)-1], extension) {
					t.Fatal("attachment publication continued past its first unconfirmed result", created)
				}
				retained := map[string][]byte{}
				for _, name := range created {
					raw, err := os.ReadFile(filepath.Join(directory, name))
					if err != nil || len(raw) == 0 {
						t.Fatal("failed attachment publication discarded its actual written evidence", err)
					}
					retained[name] = raw
				}
				if extension == ".json" && !bytes.Equal(retained[created[0]], []byte{0, 1, 255}) {
					t.Fatal("failed metadata publication changed its already committed binary")
				}
				for _, name := range []string{stateName, receiptName, completionName} {
					if _, err := os.Stat(filepath.Join(options.TargetDir, name)); !errors.Is(err, os.ErrNotExist) {
						t.Fatal("interrupted attachment published later import proof", name)
					}
				}
				if err := owner.Close(); err != nil {
					t.Fatal(err)
				}
				if _, err := Import(t.Context(), options); !errors.Is(err, ErrUnconfirmed) {
					t.Fatal("unconfirmed journal permitted attachment replay", err)
				}
				for name, before := range retained {
					after, err := os.ReadFile(filepath.Join(directory, name))
					if err != nil || !bytes.Equal(before, after) {
						t.Fatal("later admission replaced prior unconfirmed attachment bytes", err)
					}
				}
				actualJournal, err := os.ReadFile(filepath.Join(options.TargetDir, journalName))
				if err != nil || !bytes.Equal(actualJournal, journal) {
					t.Fatal("failed attachment erased its durable attempt identity", err)
				}
			})
		}
	}
}
