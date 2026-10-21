package backups

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"testing"
	"time"
)

type catalogReadFile struct {
	*os.File
	mode  string
	reads int
	t     *testing.T
}

func (file *catalogReadFile) Stat() (fs.FileInfo, error) {
	if file.mode == "stat" {
		return nil, io.ErrClosedPipe
	}
	return file.File.Stat()
}

func (file *catalogReadFile) Read(data []byte) (int, error) {
	file.reads++
	if file.mode == "prefix" || (file.mode == "header" && file.reads == 2) {
		return 0, io.ErrClosedPipe
	}
	count, err := file.File.Read(data)
	if file.reads == 2 {
		switch file.mode {
		case "changed-header":
			file.changeTime()
		case "linked-header":
			if err := os.Link(file.Name(), file.Name()+".unowned-link"); err != nil {
				file.t.Fatal(err)
			}
		}
	}
	return count, err
}

func (file *catalogReadFile) ReadAt(data []byte, offset int64) (int, error) {
	if file.mode == "body" {
		return 0, io.ErrClosedPipe
	}
	count, err := file.File.ReadAt(data, offset)
	if file.mode == "short-body" && count > 0 {
		return count - 1, io.EOF
	}
	if file.mode == "changed-body" {
		file.changeTime()
	}
	return count, err
}

func (file *catalogReadFile) changeTime() {
	file.t.Helper()
	stat, err := file.File.Stat()
	if err != nil {
		file.t.Fatal(err)
	}
	changed := stat.ModTime().Add(2 * time.Second)
	if err := os.Chtimes(file.Name(), changed, changed); err != nil {
		file.t.Fatal(err)
	}
}

func TestVaultCatalogReadFailuresNeverReturnPlaintextOrAlterOriginalBytes(t *testing.T) {
	for _, mode := range []string{"open", "stat", "prefix", "header", "changed-header", "linked-header", "body", "short-body", "changed-body"} {
		t.Run(mode, func(t *testing.T) {
			vault, metadata := vaultFixture(t)
			if err := vault.Save(t.Context(), bytes.NewReader(fixtureArchive([]byte("{}"))), metadata); err != nil {
				t.Fatal(err)
			}
			name, err := vault.file(metadata.ID)
			if err != nil {
				t.Fatal(err)
			}
			original, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			var opened *os.File
			vault.open = func(candidate string) (vaultReadFile, error) {
				if mode == "open" {
					return nil, io.ErrClosedPipe
				}
				file, err := os.Open(candidate)
				if err != nil {
					return nil, err
				}
				opened = file
				return &catalogReadFile{File: file, mode: mode, t: t}, nil
			}

			result, err := vault.Open(t.Context(), metadata.ID)
			if err == nil || result.Reader != nil {
				if result.Reader != nil {
					result.Reader.Close()
				}
				t.Fatal("unconfirmed catalog read returned plaintext")
			}
			if opened != nil {
				if _, err := opened.Read(make([]byte, 1)); !errors.Is(err, fs.ErrClosed) {
					t.Fatal("failed catalog read retained its source handle", err)
				}
			}
			if current, err := os.ReadFile(name); err != nil || !bytes.Equal(current, original) {
				t.Fatal("failed catalog read changed the original encrypted bytes", err)
			}
			assertVaultPrivateStagesEmpty(t, vault)
		})
	}
}

func TestVaultRetentionDoesNotDeleteAnUnconfirmedOrReplacedCatalogFile(t *testing.T) {
	for _, mode := range []string{"replaced", "close-error"} {
		t.Run(mode, func(t *testing.T) {
			vault, old := vaultFixture(t)
			archive := fixtureArchive([]byte("{}"))
			if err := vault.Save(t.Context(), bytes.NewReader(archive), old); err != nil {
				t.Fatal(err)
			}
			newer := old
			newer.ID, newer.CreatedAt = NewID(), old.CreatedAt+1000
			if err := vault.Save(t.Context(), bytes.NewReader(archive), newer); err != nil {
				t.Fatal(err)
			}
			name, err := vault.file(old.ID)
			if err != nil {
				t.Fatal(err)
			}
			original, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			opens := 0
			vault.open = func(candidate string) (vaultReadFile, error) {
				file, err := os.Open(candidate)
				if err != nil {
					return nil, err
				}
				wrapped := &vaultFailureFile{File: file}
				if candidate == name {
					opens++
					// The first inspection belongs to List; the second owns retention.
					if opens == 2 {
						if mode == "close-error" {
							wrapped.failure = "close"
						} else {
							wrapped.onClose = func() {
								if err := os.Rename(candidate, candidate+".retained"); err != nil {
									t.Fatal(err)
								}
								if err := os.WriteFile(candidate, []byte("unowned replacement"), 0600); err != nil {
									t.Fatal(err)
								}
							}
						}
					}
				}
				return wrapped, nil
			}

			err = vault.Retain(t.Context(), 1)
			if opens != 2 {
				t.Fatal("retention did not inspect its selected original")
			}
			preserved, readErr := os.ReadFile(name)
			if readErr != nil {
				t.Fatal("retention deleted an unconfirmed or replaced catalog file", readErr)
			}
			if mode == "replaced" {
				if string(preserved) != "unowned replacement" {
					t.Fatal("retention changed the replacement")
				}
				preserved, readErr = os.ReadFile(name + ".retained")
			}
			if readErr != nil || !bytes.Equal(preserved, original) {
				t.Fatal("retention lost the original encrypted evidence", readErr)
			}
			if !errors.Is(err, ErrInvalid) {
				t.Fatal("retention reported success without confirmed deletion", err)
			}
			if _, err := vault.ReadHeader(newer.ID); err != nil {
				t.Fatal("failed retention damaged the newer backup", err)
			}
		})
	}
}
