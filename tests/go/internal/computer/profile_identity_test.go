package computer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os/user"
	"path/filepath"
	"runtime"
	"testing"
)

func TestProfileOwnerUsesOnlyTheCapturedPlatformAccountAndPreservesItsStableDigest(t *testing.T) {
	for _, test := range []struct{ platform, name, home, uid, canonical string }{
		{"windows", `FIXTURE-DOMAIN\synthetic`, `R:\Synthetic Home`, "ignored-windows-sid", `{"name":"synthetic","home":"R:\\Synthetic Home","uid":-1}`},
		{"windows", "synthetic", `R:\Synthetic Home`, "ignored-windows-sid", `{"name":"synthetic","home":"R:\\Synthetic Home","uid":-1}`},
		{"linux", "synthetic", "/synthetic/home", "1000", `{"name":"synthetic","home":"/synthetic/home","uid":1000}`},
		{"linux", `domain\synthetic`, "/synthetic/home", "0", `{"name":"domain\\synthetic","home":"/synthetic/home","uid":0}`},
	} {
		t.Run(test.platform+"/"+test.name, func(t *testing.T) {
			calls := 0
			actual, err := readProfileOwner(test.platform, func() (*user.User, error) {
				calls++
				return &user.User{Username: test.name, HomeDir: test.home, Uid: test.uid}, nil
			})
			want := sha256.Sum256([]byte(test.canonical))
			if err != nil || actual != hex.EncodeToString(want[:]) || calls != 1 {
				t.Fatal("profile owner changed stable captured identity semantics", err)
			}
		})
	}
	if _, err := readProfileOwner("linux", func() (*user.User, error) { return nil, errors.New("synthetic account lookup failure") }); !errors.Is(err, ErrBinding) {
		t.Fatal("native account lookup failure leaked a raw error", err)
	}
	if _, err := readProfileOwner("linux", func() (*user.User, error) { return &user.User{Uid: "not-numeric"}, nil }); !errors.Is(err, ErrBinding) {
		t.Fatal("invalid Unix identity was coerced into another owner", err)
	}
}

func TestProfileRegistryDefaultsFollowTheSelectedHomeAndCapturedLocalAppData(t *testing.T) {
	home := t.TempDir()
	selected := filepath.Join(t.TempDir(), "captured-local-app-data")
	withEnvironment := DefaultProfileRegistry(home, map[string]string{"LOCALAPPDATA": selected})
	withoutEnvironment := DefaultProfileRegistry(home, nil)
	want := filepath.Join(home, ".local", "share", "dant", "vm-profiles.json")
	if runtime.GOOS == "windows" {
		if withEnvironment != filepath.Join(selected, "dant", "vm-profiles.json") || withoutEnvironment != filepath.Join(home, "AppData", "Local", "dant", "vm-profiles.json") {
			t.Fatal("Windows registry defaults ignored the captured directory boundary")
		}
	} else if withEnvironment != want || withoutEnvironment != want {
		t.Fatal("non-Windows registry default read Windows host configuration")
	}
}
