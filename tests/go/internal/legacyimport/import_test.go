package legacyimport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/ownership"
)

func exportFixture(t *testing.T, raw string, attachments map[string][]byte) Options {
	t.Helper()
	root := t.TempDir()
	options := Options{SourceDir: filepath.Join(root, "export"), TargetDir: filepath.Join(root, "new-data")}
	if err := os.MkdirAll(filepath.Join(options.SourceDir, "files"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		manifestName: []byte(`{"id":"one-import","messages":1,"description":"retained export metadata"}`),
		stateName:    []byte(raw),
	} {
		if err := os.WriteFile(filepath.Join(options.SourceDir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for id, data := range attachments {
		if err := os.WriteFile(filepath.Join(options.SourceDir, "files", id), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return options
}

func importedState(t *testing.T, options Options) contracts.RawObject {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(options.TargetDir, stateName))
	if err != nil {
		t.Fatal(err)
	}
	value, err := contracts.DecodeObject(raw, stateMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestImportArchivesLegacyFilesOncePreservesOriginalTextAndIsAuthenticatedIdempotent(t *testing.T) {
	original := `{
  "messages": [
    {"id":"message-one","role":"user","text":"original \ud800 <>& 中文 😀","attachments":[{"id":"legacy-upload","name":"folder/report.txt","type":"text/plain"}]},
    {"id":"message-two","role":"assistant","attachments":[{"id":"legacy-upload","name":"ignored-second-name"}]}
  ],
  "settings":{"vm":{"host":"host-private","keyPath":"HOST PRIVATE KEY PATH","knownHosts":"host-private"},"language":"en"},
  "memory":"user's authored memory"
}`
	options := exportFixture(t, original, map[string][]byte{"legacy-upload": []byte("report")})
	beforeManifest, _ := os.ReadFile(filepath.Join(options.SourceDir, manifestName))
	result, err := Import(t.Context(), options)
	if err != nil || !result.OK || result.Existing || result.Files != 1 || result.Unavailable != 0 {
		t.Fatal("the explicit legacy import did not finish", err)
	}
	state := importedState(t, options)
	if _, exists := state["conversationId"]; exists {
		t.Fatal("the importer invented a conversation identity")
	}
	messages, _ := objects(state["messages"], false)
	first, _ := objects(messages[0]["attachments"], false)
	second, _ := objects(messages[1]["attachments"], false)
	if !bytes.Equal(wire(first[0]), wire(second[0])) {
		t.Fatal("one legacy ID was mapped to multiple archival identities")
	}
	var attachment contracts.Attachment
	if json.Unmarshal(wire(first[0]), &attachment) != nil || !validUUID(attachment.ID) || attachment.ID == "legacy-upload" || attachment.Name != "report.txt" {
		t.Fatal("attachment IDs or safe display metadata were not migrated")
	}
	archive, err := files.OpenAttachmentStore(filepath.Join(options.TargetDir, "attachments"))
	if err != nil {
		t.Fatal(err)
	}
	_, content, err := archive.Read(t.Context(), attachment.ID)
	if err != nil || string(content) != "report" || attachment.GuestPath != filepath.Join(archive.Directory(), attachment.ID+".bin") {
		t.Fatal("the existing attachment reader could not consume the archive", err)
	}
	var originalObject contracts.RawObject
	_ = json.Unmarshal([]byte(original), &originalObject)
	originalMessages, _ := objects(originalObject["messages"], false)
	// JSON escaping may change, but every original UTF-16 unit must survive.
	units, _ := contracts.DecodeJSONTextUnits(messages[0]["text"])
	originalUnits, _ := contracts.DecodeJSONTextUnits(originalMessages[0]["text"])
	if !bytes.Equal(wire(units), wire(originalUnits)) {
		t.Fatal("original user text was repaired or translated")
	}
	if bytes.Contains(state["settings"], []byte("HOST PRIVATE")) || bytes.Contains(state["settings"], []byte("host-private")) {
		t.Fatal("host VM credentials entered the active imported settings")
	}
	for name, expected := range map[string][]byte{stateName: []byte(original), manifestName: beforeManifest} {
		sourceBytes, _ := os.ReadFile(filepath.Join(options.SourceDir, name))
		evidenceName := originalStateName
		if name == manifestName {
			evidenceName = originalManifestName
		}
		evidence, _ := os.ReadFile(filepath.Join(options.TargetDir, evidenceName))
		if !bytes.Equal(sourceBytes, expected) || !bytes.Equal(evidence, expected) {
			t.Fatal("the original export or exact private evidence changed")
		}
	}
	committed, _ := os.ReadFile(filepath.Join(options.TargetDir, stateName))
	result, err = Import(t.Context(), options)
	if err != nil || !result.Existing || result.Files != 1 {
		t.Fatal("a fully authenticated identical import was not idempotent", err)
	}
	after, _ := os.ReadFile(filepath.Join(options.TargetDir, stateName))
	entries, _ := os.ReadDir(filepath.Join(options.TargetDir, "attachments"))
	if !bytes.Equal(after, committed) || len(entries) != 2 {
		t.Fatal("idempotent import rewrote state or assigned another UUID")
	}
}

func TestImportArchivesArbitraryBinaryAndMarksMissingReferencesUnavailable(t *testing.T) {
	content := []byte{0, 255, 128, 1, 2, 0, 'x'}
	options := exportFixture(t, `{"messages":[{"attachments":[{"id":"binary-file","name":"misleading.json"},{"id":"missing-file","name":"gone.txt"}]},{"attachments":[{"id":"missing-file","name":"same unavailable reference"}]}],"settings":null}`, map[string][]byte{"binary-file": content})
	result, err := Import(t.Context(), options)
	if err != nil || result.Files != 1 || result.Unavailable != 1 {
		t.Fatal("binary or unavailable export content was lost", err)
	}
	state := importedState(t, options)
	messages, _ := objects(state["messages"], false)
	attachments, _ := objects(messages[0]["attachments"], false)
	var archived contracts.Attachment
	_ = json.Unmarshal(wire(attachments[0]), &archived)
	raw, err := os.ReadFile(archived.GuestPath)
	if err != nil || !bytes.Equal(raw, content) || archived.Type != "application/octet-stream" || archived.Name != "misleading.json" {
		t.Fatal("a misleading extension caused binary content to be parsed or altered", err)
	}
	for _, message := range messages {
		entries, _ := objects(message["attachments"], false)
		for _, entry := range entries {
			if id, _ := text(entry["id"]); id == "missing-file" && string(entry["unavailable"]) != "true" {
				t.Fatal("a repeated missing reference remained usable")
			}
		}
	}
	var migration contracts.RawObject
	_ = json.Unmarshal(state["migration"], &migration)
	if string(migration["warnings"]) != `["attachment_missing"]` {
		t.Fatal("missing-file warnings were unbounded, duplicated or contained private paths")
	}
}

func TestImportPausesUnfinishedWorkWithoutInventingIdentitiesOrSuccess(t *testing.T) {
	options := exportFixture(t, `{
"messages":[{"id":"known","role":"user","status":"running","submission":"submitting","text":"keep"},{"role":"assistant","status":"streaming"},{"role":"user","status":"future-status","submission":"future-submission"}],
"workTasks":[{"id":"existing-work","turnId":"existing-turn","status":"continuing","updatedAt":123,"continuation":{"nextAt":456,"dispatch":{"phase":"submitting","attemptId":"existing-attempt"}}},{"status":"completed"},{"status":42}],
"schedules":[{"id":"original-schedule","enabled":true,"status":"pending","nextRunAt":777},{"status":"dispatched","enabled":true},{"status":"future-schedule","enabled":true}],
"threadId":"old-thread","threadRuntime":"old-runtime","queue":["pending"],"callInputHistory":[{"id":"speech","submission":"pending"}]
}`, nil)
	if _, err := Import(t.Context(), options); err != nil {
		t.Fatal(err)
	}
	state := importedState(t, options)
	messages, _ := objects(state["messages"], false)
	if string(messages[0]["status"]) != `"unknown"` || string(messages[0]["submission"]) != `"unknown"` || string(messages[1]["status"]) != `"paused"` || string(messages[2]["status"]) != `"future-status"` || string(messages[2]["unknownOutcome"]) != "true" {
		t.Fatal("unconfirmed execution was replayable or converted into success")
	}
	work, _ := objects(state["workTasks"], false)
	if string(work[0]["id"]) != `"existing-work"` || string(work[0]["turnId"]) != `"existing-turn"` || string(work[0]["updatedAt"]) != "123" || string(work[0]["status"]) != `"unknown"` || string(work[1]["status"]) != `"completed"` {
		t.Fatal("durable work identity, timestamp or completion was invented")
	}
	if string(work[2]["status"]) != "42" || string(work[2]["unknownOutcome"]) != "true" {
		t.Fatal("an unfamiliar legacy status was normalized into trusted execution state")
	}
	schedules, _ := objects(state["schedules"], false)
	for _, item := range schedules {
		if string(item["enabled"]) != "false" {
			t.Fatal("an imported schedule can execute automatically")
		}
	}
	if string(schedules[0]["status"]) != `"paused"` || string(schedules[0]["nextRunAt"]) != "777" || string(schedules[1]["status"]) != `"dispatched"` || string(schedules[2]["status"]) != `"future-schedule"` || string(state["threadId"]) != "null" {
		t.Fatal("scheduling evidence or old runtime binding was mishandled")
	}
	if _, exists := state["conversationId"]; exists {
		t.Fatal("a missing legacy conversation identity was fabricated")
	}
}

func TestUnknownStatusJSONValuesSurviveUnconfirmedSubmissionAndDispatch(t *testing.T) {
	for _, rawStatus := range []string{`"future-status"`, `42`, `null`, `true`, `{"future":"state"}`, `["future"]`} {
		for _, uncertainty := range []string{`"submission":"submitting"`, `"continuation":{"nextAt":123,"dispatch":{"phase":"submitting"}}`} {
			options := exportFixture(t, `{"messages":[{"role":"user","status":`+rawStatus+`,`+uncertainty+`}],"workTasks":[{"status":`+rawStatus+`,`+uncertainty+`}]}`, nil)
			if _, err := Import(t.Context(), options); err != nil {
				t.Fatal(err)
			}
			state := importedState(t, options)
			for _, key := range []string{"messages", "workTasks"} {
				entries, _ := objects(state[key], false)
				if !bytes.Equal(entries[0]["status"], []byte(rawStatus)) || string(entries[0]["unknownOutcome"]) != "true" {
					t.Fatal("unknown status evidence was replaced by a trusted state")
				}
			}
		}
	}
	options := exportFixture(t, `{"messages":[{"role":"user","status":"read"}]}`, nil)
	if _, err := Import(t.Context(), options); err != nil {
		t.Fatal(err)
	}
	entries, _ := objects(importedState(t, options)["messages"], false)
	if string(entries[0]["status"]) != `"paused"` {
		t.Fatal("legacy read state bypassed the existing restored-user pause barrier")
	}
}

func TestImportRefusesAuthoritativeAndAmbiguousTargetsWithoutOverwritingThem(t *testing.T) {
	for _, variant := range []string{"authoritative state", "old same-id receipt", "interrupted journal", "orphan attachments"} {
		t.Run(variant, func(t *testing.T) {
			options := exportFixture(t, `{"messages":[],"settings":{}}`, nil)
			_ = os.Mkdir(options.TargetDir, 0700)
			name := stateName
			raw := []byte(`{"messages":[{"id":"existing-vm-work"}]}`)
			switch variant {
			case "old same-id receipt":
				name, raw = receiptName, []byte(`{"id":"one-import"}`)
			case "interrupted journal":
				name, raw = journalName, []byte(`{"incomplete":"evidence"}`)
			case "orphan attachments":
				name, raw = "orphan.bin", []byte{0, 255, 1}
			}
			_ = os.WriteFile(filepath.Join(options.TargetDir, name), raw, 0600)
			if _, err := Import(t.Context(), options); err == nil {
				t.Fatal("authoritative data or an uncertain import was overwritten")
			}
			after, _ := os.ReadFile(filepath.Join(options.TargetDir, name))
			if !bytes.Equal(after, raw) {
				t.Fatal("rejected import changed existing evidence")
			}
		})
	}
}

func TestIncompletePublicationCannotBeAutomaticallyReplayedAfterRestart(t *testing.T) {
	for _, absent := range []string{completionName, receiptName} {
		options := exportFixture(t, `{"messages":[{"attachments":[{"id":"one","name":"one.bin"}]}]}`, map[string][]byte{"one": {0, 1, 2}})
		if _, err := Import(t.Context(), options); err != nil {
			t.Fatal(err)
		}
		state, _ := os.ReadFile(filepath.Join(options.TargetDir, stateName))
		_ = os.Remove(filepath.Join(options.TargetDir, absent))
		if _, err := Import(t.Context(), options); !errors.Is(err, ErrUnconfirmed) {
			t.Fatal("incomplete publication was resumed as a successful import", err)
		}
		after, _ := os.ReadFile(filepath.Join(options.TargetDir, stateName))
		entries, _ := os.ReadDir(filepath.Join(options.TargetDir, "attachments"))
		if !bytes.Equal(after, state) || len(entries) != 2 {
			t.Fatal("restart repeated a UUID mapping or modified accepted state")
		}
	}
}

func TestIdempotenceAuthenticatesSourcesAndEveryCommittedOutput(t *testing.T) {
	for _, changed := range []string{"source state", "source manifest", "source attachment", "target state", "target attachment", "target metadata", "original evidence", "receipt"} {
		t.Run(changed, func(t *testing.T) {
			options := exportFixture(t, `{"messages":[{"attachments":[{"id":"one","name":"one.bin"}]}]}`, map[string][]byte{"one": {0, 1, 2}})
			if _, err := Import(t.Context(), options); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(options.TargetDir, stateName)
			switch changed {
			case "source state":
				file = filepath.Join(options.SourceDir, stateName)
			case "source manifest":
				file = filepath.Join(options.SourceDir, manifestName)
			case "source attachment":
				file = filepath.Join(options.SourceDir, "files", "one")
			case "target attachment", "target metadata":
				entries, _ := os.ReadDir(filepath.Join(options.TargetDir, "attachments"))
				for _, entry := range entries {
					if strings.HasSuffix(entry.Name(), ".bin") == (changed == "target attachment") {
						file = filepath.Join(options.TargetDir, "attachments", entry.Name())
					}
				}
			case "original evidence":
				file = filepath.Join(options.TargetDir, originalStateName)
			case "receipt":
				file = filepath.Join(options.TargetDir, receiptName)
			}
			raw, _ := os.ReadFile(file)
			if strings.Contains(changed, "attachment") {
				raw = append(raw, 7)
			} else {
				raw = append(raw, '\n')
			}
			_ = os.WriteFile(file, raw, 0600)
			if _, err := Import(t.Context(), options); err == nil {
				t.Fatal("changed source or output was accepted as an identical import")
			}
			after, _ := os.ReadFile(file)
			if !bytes.Equal(after, raw) {
				t.Fatal("failed authentication overwrote the changed evidence")
			}
		})
	}
}

func TestImportRequiresExclusiveTargetOwnershipAndPreservesCancelledEmptyTargets(t *testing.T) {
	options := exportFixture(t, `{"messages":[]}`, nil)
	owner, err := ownership.Acquire(t.Context(), options.TargetDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Import(t.Context(), options); !errors.Is(err, ErrBusy) {
		t.Fatal("another live owner did not fence the import", err)
	}
	_ = owner.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := Import(ctx, options); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled import changed the target", err)
	}
	if _, err := os.Stat(filepath.Join(options.TargetDir, journalName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cancelled import created an action fence", err)
	}
}
