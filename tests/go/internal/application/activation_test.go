package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/buildinfo"
	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

type activationFixture struct {
	startup config.Startup
	attempt installationAttempt
	root    string
	state   []byte
}

func newActivationFixture(t *testing.T) activationFixture {
	t.Helper()
	home := t.TempDir()
	root := filepath.Join(home, "dant")
	target := filepath.Join(root, "releases", "source.fixture")
	data := filepath.Join(root, "data")
	workspace := filepath.Join(root, "workspaces")
	for _, directory := range []string{target, data, workspace, filepath.Join(root, "installation-backups")} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	persistence, err := store.OpenContext(context.Background(), data, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	persistence.Close()
	state, _ := os.ReadFile(filepath.Join(data, "state.json"))
	manifest := computer.BundleManifest{
		SchemaVersion: 1,
		Version:       "0.4.7-beta.12",
		SourceCommit:  strings.Repeat("a", 40),
	}
	for _, name := range []string{
		computer.GuestBinaryPath, "vm/install-worker.sh", "vm/worker-install.py", "vm/guest.py",
		"vm/control.py", "vm/desktop.py", "vm/desktop_mcp.py", "vm/start-codex.sh",
		"vm/transcribe_audio.py", "vm/voice_message.py", config.ProtocolResourcePath,
	} {
		content := []byte("isolated verified resource " + name)
		file := filepath.Join(target, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, content, 0600); err != nil {
			t.Fatal(err)
		}
		manifest.Files = append(manifest.Files, computer.BundleFile{
			Path:   name,
			Bytes:  int64(len(content)),
			SHA256: digestBytes(content),
		})
	}
	raw, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(target, filepath.FromSlash(computer.BundleManifestPath)), raw, 0600); err != nil {
		t.Fatal(err)
	}
	_, canonical, err := computer.VerifyBundle(context.Background(), target, manifest.Version, manifest.SourceCommit)
	if err != nil {
		t.Fatal(err)
	}

	backup, err := backups.CreateWorkerBackup(context.Background(), backups.WorkerBackupOptions{
		DataDir:       data,
		WorkspaceRoot: workspace,
		AppVersion:    manifest.Version,
		SourceID:      digestBytes(canonical),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	var archive bytes.Buffer
	if err := backup.WriteTo(context.Background(), &archive); err != nil {
		t.Fatal(err)
	}
	backupName := "49954ce5-c8c5-4f6e-a7d8-531530d09479.raw"
	backupPath := filepath.Join(root, "installation-backups", backupName)
	if err := os.WriteFile(backupPath, archive.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	info, _ := file.Stat()
	identity, err := preparationFileIdentity(file)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	fixture := activationFixture{
		startup: config.Startup{
			Home:          home,
			Root:          target,
			DataDir:       data,
			WorkspaceRoot: workspace,
			Backup:        backupPath,
			Role:          config.RoleWorker,
		},
		attempt: installationAttempt{
			SchemaVersion:    1,
			AttemptID:        "39954ce5-c8c5-4f6e-a7d8-531530d09479",
			Source:           digestBytes(canonical),
			SourceCommit:     manifest.SourceCommit,
			Version:          manifest.Version,
			Directory:        filepath.Base(target),
			Phase:            contracts.WorkerInstallationPhasePreparing,
			Backup:           backupName,
			BackupBytes:      info.Size(),
			BackupModifiedNS: strconv.FormatInt(info.ModTime().UnixNano(), 10),
			BackupIdentity:   identity,
		},
		root:  root,
		state: state,
	}
	fixture.writeAttempt(t)
	return fixture
}

func (fixture activationFixture) writeAttempt(t *testing.T) {
	t.Helper()
	raw, err := json.Marshal(fixture.attempt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.root, installationJournal), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func (fixture *activationFixture) prepare(t *testing.T) {
	t.Helper()
	fixture.bindBuild(t)
	if err := prepareData(context.Background(), fixture.startup); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(fixture.root, preparationFile))
	if err != nil {
		t.Fatal(err)
	}
	var proof preparationReceipt
	if err := json.Unmarshal(raw, &proof); err != nil {
		t.Fatal(err)
	}
	fixture.attempt.BackupSHA256 = proof.BackupSHA256
	fixture.attempt.PreparationSHA256 = digestBytes(raw)
	fixture.attempt.Phase = contracts.WorkerInstallationPhaseActivating
	fixture.writeAttempt(t)
}

func (fixture activationFixture) bindBuild(t *testing.T) {
	t.Helper()
	version, source := buildinfo.Version, buildinfo.Source
	buildinfo.Version, buildinfo.Source = fixture.attempt.Version, fixture.attempt.SourceCommit
	t.Cleanup(func() { buildinfo.Version, buildinfo.Source = version, source })
}

func TestIndependentWorkerStartRefusesEveryUnpreparedPhaseBeforeWrites(t *testing.T) {
	for _, phase := range []contracts.WorkerInstallationPhase{
		contracts.WorkerInstallationPhaseReserving,
		contracts.WorkerInstallationPhaseStopping,
		contracts.WorkerInstallationPhasePreparing,
		contracts.WorkerInstallationPhaseActivating,
		contracts.WorkerInstallationPhaseCommitted,
	} {
		t.Run(string(phase), func(t *testing.T) {
			fixture := newActivationFixture(t)
			fixture.bindBuild(t)
			fixture.attempt.Phase = phase
			fixture.writeAttempt(t)
			if _, err := assembleService(context.Background(), fixture.startup, ""); !errors.Is(err, ErrActivation) {
				t.Fatal("independent service start bypassed preparation", err)
			}
			actual, _ := os.ReadFile(filepath.Join(fixture.startup.DataDir, "state.json"))
			if !bytes.Equal(actual, fixture.state) {
				t.Fatal("rejected start changed the saved conversation")
			}
			if _, err := os.Lstat(filepath.Join(fixture.startup.DataDir, "memory")); !os.IsNotExist(err) {
				t.Fatal("rejected start opened memory migration")
			}
		})
	}
}

func TestPreparationAuthenticatesArchiveAndPublishesBuildBoundReceipt(t *testing.T) {
	fixture := newActivationFixture(t)
	fixture.prepare(t)
	root, err := checkWorkerActivation(context.Background(), fixture.startup, fixture.attempt.Version, fixture.attempt.SourceCommit)
	if err != nil || root != fixture.startup.Root {
		t.Fatal("verified preparation did not admit the exact candidate", err)
	}
	archive, _ := os.ReadFile(fixture.startup.Backup)
	if fixture.attempt.BackupSHA256 != digestBytes(archive) {
		t.Fatal("receipt did not authenticate exact complete archive bytes")
	}
	if _, err := checkWorkerActivation(context.Background(), fixture.startup, fixture.attempt.Version, strings.Repeat("b", 40)); !errors.Is(err, ErrActivation) {
		t.Fatal("other executable source reused the proof")
	}

	if err := os.Remove(fixture.startup.Backup); err != nil {
		t.Fatal(err)
	}
	if _, err := checkWorkerActivation(context.Background(), fixture.startup, fixture.attempt.Version, fixture.attempt.SourceCommit); !errors.Is(err, ErrActivation) {
		t.Fatal("activating start accepted a missing recovery archive")
	}
	fixture.attempt.Phase = contracts.WorkerInstallationPhaseCommitted
	fixture.writeAttempt(t)
	if _, err := checkWorkerActivation(context.Background(), fixture.startup, fixture.attempt.Version, fixture.attempt.SourceCommit); err != nil {
		t.Fatal("committed preparation depended forever on retained raw archive", err)
	}
}

func TestPreparationFailureCannotProduceBootableProof(t *testing.T) {
	fixture := newActivationFixture(t)
	fixture.bindBuild(t)
	if err := os.WriteFile(fixture.startup.Backup, []byte("invalid recovery archive"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(fixture.startup.Backup)
	if err != nil {
		t.Fatal(err)
	}
	fixture.attempt.BackupBytes = info.Size()
	fixture.attempt.BackupModifiedNS = strconv.FormatInt(info.ModTime().UnixNano(), 10)
	fixture.writeAttempt(t)
	if err := prepareData(context.Background(), fixture.startup); err == nil {
		t.Fatal("invalid recovery data was prepared")
	}
	if _, err := os.Lstat(filepath.Join(fixture.root, preparationFile)); !os.IsNotExist(err) {
		t.Fatal("failed preparation published success")
	}
	fixture.attempt.Phase = contracts.WorkerInstallationPhaseActivating
	fixture.writeAttempt(t)
	if _, err := checkWorkerActivation(context.Background(), fixture.startup, fixture.attempt.Version, fixture.attempt.SourceCommit); !errors.Is(err, ErrActivation) {
		t.Fatal("reboot admitted a failed cutover")
	}
}

func TestPreparationRechecksAttemptBeforeWritersAndOfflineBeforeProof(t *testing.T) {
	for _, variant := range []string{"attempt-changed", "offline-lost"} {
		t.Run(variant, func(t *testing.T) {
			fixture := newActivationFixture(t)
			fixture.bindBuild(t)
			observations := 0
			err := prepareDataOffline(context.Background(), fixture.startup, func(context.Context) error {
				observations++
				if variant == "attempt-changed" && observations == 2 {
					fixture.attempt.AttemptID = "29954ce5-c8c5-4f6e-a7d8-531530d09479"
					fixture.writeAttempt(t)
				}
				if variant == "offline-lost" && observations == 3 {
					return errors.New("isolated offline proof lost")
				}
				return nil
			})
			if err == nil {
				t.Fatal("preparation ignored a lost owner")
			}
			if _, err := os.Lstat(filepath.Join(fixture.root, preparationFile)); !os.IsNotExist(err) {
				t.Fatal("unconfirmed preparation published proof")
			}
			if variant == "attempt-changed" {
				if _, err := os.Lstat(filepath.Join(fixture.startup.DataDir, "memory")); !os.IsNotExist(err) {
					t.Fatal("changed attempt admitted memory migration")
				}
			}
		})
	}
}

func TestActivationRejectsChangedProofRootsSourceAndBackupIdentity(t *testing.T) {
	for _, variant := range []string{"proof", "root", "attempt", "backup-replaced", "binary", "malformed-journal"} {
		t.Run(variant, func(t *testing.T) {
			fixture := newActivationFixture(t)
			fixture.prepare(t)
			switch variant {
			case "proof":
				os.WriteFile(filepath.Join(fixture.root, preparationFile), []byte("{}"), 0600)
			case "root":
				fixture.startup.WorkspaceRoot += "-other"
			case "attempt":
				fixture.attempt.AttemptID = "29954ce5-c8c5-4f6e-a7d8-531530d09479"
				fixture.writeAttempt(t)
			case "backup-replaced":
				before, _ := os.Stat(fixture.startup.Backup)
				content, _ := os.ReadFile(fixture.startup.Backup)
				os.Rename(fixture.startup.Backup, fixture.startup.Backup+".retired")
				os.WriteFile(fixture.startup.Backup, content, 0600)
				os.Chtimes(fixture.startup.Backup, before.ModTime(), before.ModTime())
			case "binary":
				os.WriteFile(filepath.Join(fixture.startup.Root, filepath.FromSlash(computer.GuestBinaryPath)), []byte("other binary"), 0600)
			case "malformed-journal":
				os.WriteFile(filepath.Join(fixture.root, installationJournal), []byte(`{"schemaVersion":1,"phase":null}`), 0600)
			}
			if _, err := checkWorkerActivation(context.Background(), fixture.startup, fixture.attempt.Version, fixture.attempt.SourceCommit); !errors.Is(err, ErrActivation) {
				t.Fatal("changed activation identity was accepted", err)
			}
		})
	}
}

func TestActivationResolvesOnlyExactManagedAppLink(t *testing.T) {
	fixture := newActivationFixture(t)
	fixture.prepare(t)
	link := filepath.Join(fixture.root, "app")
	if err := os.Symlink(fixture.startup.Root, link); err != nil {
		t.Skip("isolated directory symlink privilege unavailable")
	}
	fixture.startup.Root = link
	target := filepath.Join(fixture.root, "releases", fixture.attempt.Directory)
	if resolved, err := checkWorkerActivation(context.Background(), fixture.startup, fixture.attempt.Version, fixture.attempt.SourceCommit); err != nil || resolved != target {
		t.Fatal("exact managed app link was not resolved", err)
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), link); err != nil {
		t.Fatal(err)
	}
	if _, err := checkWorkerActivation(context.Background(), fixture.startup, fixture.attempt.Version, fixture.attempt.SourceCommit); !errors.Is(err, ErrActivation) {
		t.Fatal("foreign app link was accepted")
	}
}

func TestJournalAbsenceRemainsExplicitManualCompatibility(t *testing.T) {
	startup := config.Startup{DataDir: filepath.Join(t.TempDir(), "data"), Root: "manual-fixture"}
	if root, err := checkWorkerActivation(context.Background(), startup, "", ""); err != nil || root != startup.Root {
		t.Fatal("fresh manual installation required an invented cutover receipt", err)
	}
}
