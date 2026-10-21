package legacyimport

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

type interruptedPublicationFile struct {
	publicationFile
	phase       string
	closeCalls  int
	afterStat   func() error
	hookError   error
	privateFail error
}

func (file *interruptedPublicationFile) Write(raw []byte) (int, error) {
	if file.phase == "write" || file.phase == "short-write" {
		count, err := file.publicationFile.Write(raw[:len(raw)/2])
		if err != nil || file.phase == "short-write" {
			return count, err
		}
		return count, file.privateFail
	}
	return file.publicationFile.Write(raw)
}

func (file *interruptedPublicationFile) Sync() error {
	if err := file.publicationFile.Sync(); err != nil {
		return err
	}
	if file.phase == "sync" {
		return file.privateFail
	}
	return nil
}

func (file *interruptedPublicationFile) Stat() (fs.FileInfo, error) {
	info, err := file.publicationFile.Stat()
	if err != nil {
		return nil, err
	}
	if file.phase == "stat" {
		return nil, file.privateFail
	}
	if file.afterStat != nil {
		file.hookError = file.afterStat()
		if file.hookError != nil {
			return nil, file.hookError
		}
	}
	return info, nil
}

func (file *interruptedPublicationFile) Close() error {
	file.closeCalls++
	err := file.publicationFile.Close()
	if file.phase == "close" && file.closeCalls == 1 {
		return file.privateFail
	}
	return err
}

func TestExclusivePublicationPreservesRealWrittenEvidenceAcrossEveryFailure(t *testing.T) {
	for _, phase := range []string{"success", "write", "short-write", "sync", "stat", "close", "hardlink", "replaced-file"} {
		t.Run(phase, func(t *testing.T) {
			options, value, target, owner := importPublicationFixture(t)
			name := "isolated-publication.bin"
			published := filepath.Join(options.TargetDir, name)
			retained := published + ".retained"
			original := []byte("unchanged isolated publication evidence")
			replacement := []byte("retained replacement bytes")
			create := target.create
			var captured *interruptedPublicationFile
			creates := 0
			target.create = func(name string) (publicationFile, error) {
				creates++
				opened, err := create(name)
				if err != nil {
					return nil, err
				}
				captured = &interruptedPublicationFile{
					publicationFile: opened, phase: phase,
					privateFail: errors.New("isolated private publication failure"),
				}
				switch phase {
				case "hardlink":
					captured.afterStat = func() error {
						return os.Link(published, retained)
					}
				case "replaced-file":
					captured.afterStat = func() error {
						if err := os.Rename(published, retained); err != nil {
							return err
						}
						return os.WriteFile(published, replacement, 0600)
					}
				}
				return captured, nil
			}

			err := target.exclusive(t.Context(), name, original)
			want := ErrUnconfirmed
			if phase == "stat" || phase == "hardlink" || phase == "replaced-file" {
				want = ErrChanged
			}
			if phase == "success" {
				want = nil
			}
			if !errors.Is(err, want) || creates != 1 || captured == nil {
				t.Fatal("exclusive publication hid or retried an interrupted result", err, creates)
			}
			if captured.hookError != nil {
				t.Fatal("isolated identity replacement did not reach its intended boundary", captured.hookError)
			}
			if captured.closeCalls != 1 {
				t.Error("publication released the same handle more than once", captured.closeCalls)
			}
			expected := original
			if phase == "write" || phase == "short-write" {
				expected = original[:len(original)/2]
			} else if phase == "replaced-file" {
				expected = replacement
				data, err := os.ReadFile(retained)
				if err != nil || !bytes.Equal(data, original) {
					t.Fatal("retired publication evidence was removed or rewritten", err)
				}
			}
			data, err := os.ReadFile(published)
			if err != nil || !bytes.Equal(data, expected) {
				t.Fatal("publication failure replaced its actual written evidence", err)
			}
			_ = owner.Close()
			if _, err := Import(t.Context(), options); !errors.Is(err, ErrConflict) {
				t.Fatal("an uncertain isolated publication was blindly replayed", err)
			}
			data, err = os.ReadFile(published)
			if err != nil || !bytes.Equal(data, expected) {
				t.Fatal("later import admission overwrote retained publication bytes", err)
			}
			if source, err := os.ReadFile(filepath.Join(options.SourceDir, stateName)); err != nil || !bytes.Equal(source, value.stateRaw) {
				t.Fatal("publication failure rewrote the source export", err)
			}
		})
	}
}
