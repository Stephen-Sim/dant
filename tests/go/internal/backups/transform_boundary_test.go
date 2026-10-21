package backups

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTransformPublicChildBoundaryValidatesReceiptsAndJoinsCancellation(t *testing.T) {
	request := TransformRequest{Directory: t.TempDir(), Mode: "encrypt", Bytes: 1, Key: make([]byte, gcmKeyBytes), Nonce: make([]byte, gcmNonceBytes)}
	request.File, _ = stageName(request.Directory, NewID())
	if err := os.WriteFile(request.File, make([]byte, request.Bytes+gcmTagBytes), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Transform(t.Context(), "relative", request); !errors.Is(err, ErrInvalid) {
		t.Fatal("relative executable accepted")
	}
	large := request
	large.AAD = bytes.Repeat([]byte{'x'}, TransformRequestMaxBytes)
	if err := Transform(t.Context(), os.Args[0], large); !errors.Is(err, ErrInvalid) {
		t.Fatal("oversized child request accepted")
	}
	if err := Transform(t.Context(), filepath.Join(t.TempDir(), "missing-core"), request); !errors.Is(err, ErrInvalid) {
		t.Fatal("failed child executable reported success")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := Transform(ctx, os.Args[0], request); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled child operation changed uncertainty classification")
	}

	for _, mode := range []string{"oversized", "malformed", "not-ok", "wrong-size", "child-fails"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("DANT_BACKUP_TRANSFORM_RECEIPT_FIXTURE", mode)
			if err := Transform(t.Context(), os.Args[0], request); !errors.Is(err, ErrInvalid) {
				t.Fatal("unconfirmed child output accepted")
			}
		})
	}
	t.Setenv("DANT_BACKUP_TRANSFORM_FIXTURE_CHILD", "1")
	if err := Transform(t.Context(), os.Args[0], request); err != nil {
		t.Fatal(err)
	}
	request.Mode = "decrypt"
	if err := Transform(t.Context(), os.Args[0], request); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(request.File)
	if err != nil || !bytes.Equal(raw, []byte{0}) {
		t.Fatal("child transform changed authenticated plaintext")
	}
}

func TestTransformRequestValidationPrecedesMutationAndOutput(t *testing.T) {
	root := t.TempDir()
	name, _ := stageName(root, NewID())
	original := bytes.Repeat([]byte{'a'}, gcmTagBytes+1)
	if err := os.WriteFile(name, original, 0600); err != nil {
		t.Fatal(err)
	}
	valid := TransformRequest{Directory: root, File: name, Mode: "encrypt", Bytes: 1, Key: make([]byte, gcmKeyBytes), Nonce: make([]byte, gcmNonceBytes)}
	for _, mode := range []string{"reader", "oversized", "duplicate", "type", "directory", "missing", "mode", "nonce", "aad", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			request := valid
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch mode {
			case "directory":
				request.Directory = filepath.Join(root, "missing")
				request.File = filepath.Join(request.Directory, filepath.Base(name))
			case "missing":
				request.File, _ = stageName(root, NewID())
			case "mode":
				request.Mode = "unknown"
			case "nonce":
				request.Nonce = nil
			case "aad":
				request.AAD = bytes.Repeat([]byte{'x'}, transformAADMaxBytes+1)
			case "cancelled":
				cancel()
			}
			raw, _ := json.Marshal(request)
			var input io.Reader = bytes.NewReader(raw)
			switch mode {
			case "reader":
				input = errorReader{}
			case "oversized":
				input = strings.NewReader(strings.Repeat("x", TransformRequestMaxBytes+1))
			case "duplicate":
				input = strings.NewReader(`{"mode":"encrypt","mode":"decrypt"}`)
			case "type":
				input = strings.NewReader(`{"directory":1,"file":1,"mode":1,"bytes":1,"key":1,"nonce":1,"aad":1}`)
			}
			var output bytes.Buffer
			if err := RunTransform(ctx, input, &output); err == nil || output.Len() != 0 {
				t.Fatal("invalid or cancelled transform published receipt")
			}
			current, _ := os.ReadFile(name)
			if !bytes.Equal(current, original) {
				t.Fatal("invalid transform changed unrelated stage")
			}
		})
	}
	if _, err := stageName(root, "../caller-output"); !errors.Is(err, ErrInvalid) {
		t.Fatal("caller selected transform output filename")
	}
}
