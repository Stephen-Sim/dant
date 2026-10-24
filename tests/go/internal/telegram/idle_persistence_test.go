package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

func TestIdleTelegramFlushPreservesConfigurationAndDirectoryMetadata(t *testing.T) {
	fixture := fixture(t)
	name := fixture.Gateway.file
	before, err := files.CaptureIdentity(name)
	if err != nil {
		t.Fatal(err)
	}
	root, err := files.CaptureIdentity(fixture.Directory)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := fixture.Gateway.Flush(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	after, err := files.CaptureIdentity(name)
	if err != nil || !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("idle flush replaced or rewrote the persisted configuration", err)
	}
	currentRoot, err := files.CaptureIdentity(fixture.Directory)
	if err != nil || !os.SameFile(root, currentRoot) || !root.ModTime().Equal(currentRoot.ModTime()) {
		t.Fatal("idle flush changed the captured data directory", err)
	}
	current, err := os.ReadFile(name)
	if err != nil || !bytes.Equal(current, raw) || fixture.Sent.Load() != 0 || fixture.Admitted.Load() != 0 {
		t.Fatal("idle persistence changed content or performed external work", err)
	}
}

func TestChangedTelegramConfigurationStillPersistsAndMissingFileIsCreated(t *testing.T) {
	fixture := fixture(t)
	gateway := fixture.Gateway
	before, err := os.ReadFile(gateway.file)
	if err != nil {
		t.Fatal(err)
	}
	gateway.mu.Lock()
	gateway.config.CombineReplies = false
	err = gateway.saveLocked(t.Context())
	gateway.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(gateway.file)
	var saved Config
	if err != nil || bytes.Equal(before, after) || json.Unmarshal(after, &saved) != nil || saved.CombineReplies {
		t.Fatal("a real configuration change was not persisted", err)
	}
	if err := os.Remove(gateway.file); err != nil {
		t.Fatal(err)
	}
	gateway.mu.Lock()
	err = gateway.saveLocked(t.Context())
	gateway.mu.Unlock()
	if restored, readErr := os.ReadFile(gateway.file); err != nil || readErr != nil || !bytes.Equal(restored, after) {
		t.Fatal("a missing owned configuration was not created", err, readErr)
	}
}

func TestSameContentTelegramSaveStillRepairsPermissiveUnixMode(t *testing.T) {
	fixture := fixture(t)
	name := fixture.Gateway.file
	before, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(name, 0o644); err != nil {
		t.Fatal(err)
	}
	identity, err := files.CaptureIdentity(name)
	if err != nil {
		t.Fatal(err)
	}
	fixture.Gateway.mu.Lock()
	err = fixture.Gateway.saveLocked(t.Context())
	fixture.Gateway.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	after, err := files.CaptureIdentity(name)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		if !os.SameFile(identity, after) {
			t.Fatal("Windows mode semantics caused an unnecessary replacement")
		}
	} else if after.Mode().Perm() != 0o600 {
		t.Fatal("same-content save retained a permissive Unix mode")
	}
	if current, err := os.ReadFile(name); err != nil || !bytes.Equal(current, before) || fixture.Sent.Load() != 0 {
		t.Fatal("mode repair changed the configuration or performed external work", err)
	}
}

func TestTelegramIgnoredUpdateOffsetRemainsDurableAcrossIdleFlush(t *testing.T) {
	fixture := fixture(t)
	update := behaviorUpdate(t, 100, "ignored synthetic group update")
	update.Message.Chat.Type = "group"
	if err := fixture.Gateway.Receive(t.Context(), update); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(fixture.Gateway.file)
	var saved Config
	if err != nil || json.Unmarshal(before, &saved) != nil || saved.Offset != 101 {
		t.Fatal("an ignored update did not persist its next polling offset", err)
	}
	if _, err := fixture.Gateway.Flush(t.Context()); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(fixture.Gateway.file)
	if err != nil || !bytes.Equal(before, after) || fixture.Sent.Load() != 0 || fixture.Admitted.Load() != 0 {
		t.Fatal("idle save changed the durable offset or performed external work", err)
	}
}

type telegramSaveBoundaryContext struct {
	context.Context
	cancel    context.CancelFunc
	afterRead func()
	checks    int
}

func (ctx *telegramSaveBoundaryContext) Err() error {
	ctx.checks++
	if ctx.checks == 2 {
		if ctx.afterRead != nil {
			ctx.afterRead()
		} else {
			ctx.cancel()
		}
	}
	return ctx.Context.Err()
}

func TestCancelledAndUntrustedTelegramSavesNeverBecomeSuccessfulNoops(t *testing.T) {
	for _, scenario := range []string{"cancelled", "cancelled-after-read", "target-directory", "target-hardlink", "replaced-directory", "replaced-after-read", "directory-after-read"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := fixture(t)
			gateway := fixture.Gateway
			before, err := os.ReadFile(gateway.file)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			var owner context.Context = ctx
			switch scenario {
			case "cancelled":
				cancel()
			case "cancelled-after-read":
				owner = &telegramSaveBoundaryContext{Context: ctx, cancel: cancel}
			case "replaced-after-read", "directory-after-read":
				owner = &telegramSaveBoundaryContext{Context: ctx, afterRead: func() {
					if err := os.Rename(gateway.file, gateway.file+".retained"); err != nil {
						t.Fatal(err)
					}
					if scenario == "directory-after-read" {
						if err := os.Mkdir(gateway.file, 0o700); err != nil {
							t.Fatal(err)
						}
					} else if err := os.WriteFile(gateway.file, before, 0o600); err != nil {
						t.Fatal(err)
					}
				}}
			case "target-directory":
				if err := os.Remove(gateway.file); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(gateway.file, 0o700); err != nil {
					t.Fatal(err)
				}
			case "target-hardlink":
				retained := filepath.Join(t.TempDir(), "retained-config")
				if err := os.Link(gateway.file, retained); err != nil {
					t.Fatal(err)
				}
			case "replaced-directory":
				if err := os.Rename(gateway.directory, gateway.directory+"-retained"); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.RemoveAll(gateway.directory + "-retained") })
				if err := os.Mkdir(gateway.directory, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(gateway.file, before, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			gateway.mu.Lock()
			err = gateway.saveLocked(owner)
			gateway.mu.Unlock()
			if !errors.Is(err, ErrConfig) {
				t.Fatal("unconfirmed ownership or cancellation was accepted as an idle save", err)
			}
			if scenario == "target-directory" || scenario == "directory-after-read" {
				if info, err := os.Stat(gateway.file); err != nil || !info.IsDir() {
					t.Fatal("failed save replaced the unrelated directory", err)
				}
			} else if current, err := os.ReadFile(gateway.file); err != nil || !bytes.Equal(current, before) {
				t.Fatal("failed save changed the retained configuration", err)
			}
			if scenario == "replaced-after-read" || scenario == "directory-after-read" {
				if original, err := os.ReadFile(gateway.file + ".retained"); err != nil || !bytes.Equal(original, before) {
					t.Fatal("failed save changed the displaced original configuration", err)
				}
			}
		})
	}
}
