package files

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAutomaticDeliveryRechecksTheScannedSourceBeforePublishingAnyAttachment(t *testing.T) {
	for _, scenario := range []string{"content changed", "root replaced"} {
		t.Run(scenario, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "output")
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(directory, "result.txt")
			if err := os.WriteFile(name, []byte("scanned content"), 0600); err != nil {
				t.Fatal(err)
			}
			attachments, err := OpenAttachmentStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			notices := []string{}
			collector := NewDeliverableCollector(attachments, func(code string) { notices = append(notices, code) })
			checks := 0
			items, err := collector.ArchiveExplicit(t.Context(), ArchiveInput{
				OutputDirectory: directory,
				Baseline:        json.RawMessage(`{"valid":true,"hashes":{}}`),
				IsCurrent: func() bool {
					checks++
					if checks == 2 {
						if scenario == "root replaced" {
							if err := os.Rename(directory, directory+"-retained"); err != nil {
								t.Fatal(err)
							}
							if err := os.WriteFile(directory, []byte("replacement must survive"), 0600); err != nil {
								t.Fatal(err)
							}
						} else if err := os.WriteFile(name, []byte("different after scan"), 0600); err != nil {
							t.Fatal(err)
						}
					}
					return true
				},
			})
			if err != nil || len(items) != 0 || len(notices) != 1 || notices[0] != "output_delivery_unavailable" {
				t.Fatal("changed automatic source was attached using its old scanned hash", err)
			}
			entries, err := os.ReadDir(attachments.Directory())
			if err != nil || len(entries) != 0 {
				t.Fatal("unconfirmed source left a published attachment", err)
			}
		})
	}
}

func TestDeliverableCollectionRejectsAnOrdinaryFileAsItsOutputRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ordinary-file")
	if err := os.WriteFile(root, []byte("unrelated replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	attachments, err := OpenAttachmentStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	collector := NewDeliverableCollector(attachments, nil)
	if _, err := scanOutput(t.Context(), root); !errors.Is(err, ErrManagedPath) {
		t.Fatal("output scan traversed an ordinary file", err)
	}
	if _, _, err := collector.ReadExplicit(context.Background(), root, filepath.Join(root, "result.txt")); !errors.Is(err, ErrManagedPath) {
		t.Fatal("explicit delivery traversed an ordinary file", err)
	}
}
