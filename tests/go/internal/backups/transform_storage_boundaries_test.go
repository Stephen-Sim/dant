package backups

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type observedStageMap struct {
	mappedStage
	flush func() error
	close func() error
}

func (mapping observedStageMap) Flush() error {
	if mapping.flush != nil {
		return mapping.flush()
	}
	return mapping.mappedStage.Flush()
}

func (mapping observedStageMap) Close() error {
	if mapping.close != nil {
		return mapping.close()
	}
	return mapping.mappedStage.Close()
}

func TestMappedTransformCannotPublishSuccessAfterStorageOwnershipOrCancellationFailure(t *testing.T) {
	for _, phase := range []string{"mapping", "cancelled", "hardlink", "closed-handle", "flush", "sync", "close", "truncate", "final-sync"} {
		t.Run(phase, func(t *testing.T) {
			directory := t.TempDir()
			name, err := stageName(directory, "12345678-1234-1234-1234-123456789abc")
			if err != nil {
				t.Fatal(err)
			}
			plaintext := []byte("synthetic private archive bytes")
			key, nonce := bytes.Repeat([]byte{0x31}, gcmKeyBytes), bytes.Repeat([]byte{0x19}, gcmNonceBytes)
			request := TransformRequest{
				Directory: directory, File: name, Mode: "encrypt", Bytes: int64(len(plaintext)),
				Key: key, Nonce: nonce, AAD: []byte("synthetic authenticated header"),
			}
			contents := append(append([]byte{}, plaintext...), make([]byte, gcmTagBytes)...)
			if phase == "truncate" {
				request.Mode = "decrypt"
				block, err := aes.NewCipher(key)
				if err != nil {
					t.Fatal(err)
				}
				gcm, err := cipher.NewGCM(block)
				if err != nil {
					t.Fatal(err)
				}
				contents = gcm.Seal(nil, nonce, plaintext, request.AAD)
			}
			if err := os.WriteFile(name, contents, 0o600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			failure := errors.New("isolated mapped storage failure")
			var captured mappedStage
			mapFile := func(file *os.File, length int) (mappedStage, error) {
				if phase == "mapping" {
					return nil, failure
				}
				mapped, err := mapStage(file, length)
				if err != nil {
					return nil, err
				}
				captured = mapped
				wrapped := observedStageMap{mappedStage: mapped}
				switch phase {
				case "cancelled":
					cancel()
				case "hardlink":
					if err := os.Link(name, filepath.Join(directory, "outside-link")); err != nil {
						t.Fatal(err)
					}
				case "closed-handle":
					if err := file.Close(); err != nil {
						t.Fatal(err)
					}
				case "flush":
					wrapped.flush = func() error { return failure }
				case "sync":
					wrapped.flush = func() error {
						if err := mapped.Flush(); err != nil {
							return err
						}
						return file.Close()
					}
				case "close", "truncate", "final-sync":
					closed := false
					wrapped.close = func() error {
						if err := mapped.Close(); err != nil {
							return err
						}
						if closed {
							return nil
						}
						closed = true
						if phase == "close" {
							return failure
						}
						return file.Close()
					}
				}
				return wrapped, nil
			}
			raw, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			var receipt bytes.Buffer
			err = runTransformMapped(ctx, bytes.NewReader(raw), &receipt, mapFile)
			if err == nil || receipt.Len() != 0 {
				t.Fatal("unconfirmed transform published a success receipt", err)
			}
			if phase == "cancelled" && !errors.Is(err, context.Canceled) {
				t.Fatal("late transform cancellation lost its classification", err)
			}
			if phase == "cancelled" || phase == "hardlink" || phase == "closed-handle" {
				if contents, err := os.ReadFile(name); err != nil || !bytes.Equal(contents, make([]byte, len(contents))) {
					t.Fatal("unconfirmed transform retained sensitive staged bytes", err)
				}
			}
			if captured != nil {
				if data := captured.Bytes(); len(data) != 0 {
					t.Fatal("failed transform retained a live mapping")
				}
			}
		})
	}
}
