package backups

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/platform"
)

const ArchiveLimit = MaxBackupBytes*3/2 + 64*1024*1024
const TransformRequestMaxBytes = 128 * 1024
const transformAADMaxBytes = 64*1024 + 128
const gcmKeyBytes = 32
const gcmNonceBytes = 12
const gcmTagBytes = 16

var transformName = regexp.MustCompile(`^\.dant-transform-[a-f0-9-]{36}\.stage$`)

type TransformRequest struct {
	Directory string `json:"directory"`
	File      string `json:"file"`
	Mode      string `json:"mode"`
	Bytes     int64  `json:"bytes"`
	Key       []byte `json:"key"`
	Nonce     []byte `json:"nonce"`
	AAD       []byte `json:"aad"`
}

type TransformReceipt struct {
	OK    bool  `json:"ok"`
	Bytes int64 `json:"bytes"`
}

type mappedStage interface {
	Bytes() []byte
	Flush() error
	Close() error
}

// RunTransform is an isolated process role. It mutates only its exclusive private
// staging file, and never emits plaintext or reports success before GCM auth.
func RunTransform(ctx context.Context, input io.Reader, output io.Writer) error {
	raw, err := io.ReadAll(io.LimitReader(input, TransformRequestMaxBytes+1))
	if err != nil || len(raw) > TransformRequestMaxBytes {
		return ErrInvalid
	}
	object, err := contracts.DecodeObject(raw, TransformRequestMaxBytes)
	if err != nil || len(object) != 7 {
		return ErrInvalid
	}
	var request TransformRequest
	if json.Unmarshal(raw, &request) != nil {
		return ErrInvalid
	}
	clear(raw)
	defer clear(request.Key)
	defer clear(request.Nonce)
	defer clear(request.AAD)
	if strconv.IntSize != 64 || len(request.Key) != gcmKeyBytes || len(request.Nonce) != gcmNonceBytes || len(request.AAD) > transformAADMaxBytes || request.Bytes <= 0 || request.Bytes > ArchiveLimit || (request.Mode != "encrypt" && request.Mode != "decrypt") {
		return ErrInvalid
	}

	if !filepath.IsAbs(request.Directory) || !filepath.IsAbs(request.File) || filepath.Dir(request.File) != filepath.Clean(request.Directory) || !transformName.MatchString(filepath.Base(request.File)) {
		return ErrInvalid
	}

	if _, err := files.OrdinaryDirectory(request.Directory, false); err != nil {
		return ErrInvalid
	}
	directory, err := files.CaptureIdentity(request.Directory)
	if err != nil {
		return ErrInvalid
	}
	before, err := files.CaptureIdentity(request.File)
	if err != nil || !before.Mode().IsRegular() || before.Size() != request.Bytes+gcmTagBytes {
		return ErrInvalid
	}
	file, err := os.OpenFile(request.File, os.O_RDWR, 0)
	if err != nil {
		return ErrInvalid
	}
	defer file.Close()
	unchanged := func() bool {
		named, err := os.Lstat(request.File)
		if err != nil || !named.Mode().IsRegular() || !os.SameFile(before, named) || named.Size() != before.Size() {
			return false
		}
		opened, err := file.Stat()
		if err != nil || !os.SameFile(before, opened) || opened.Size() != before.Size() {
			return false
		}
		parent, err := os.Lstat(request.Directory)
		if err != nil || !parent.IsDir() || !os.SameFile(directory, parent) {
			return false
		}
		if _, err := files.OrdinaryDirectory(request.Directory, false); err != nil {
			return false
		}
		return stageSingleLink(file)
	}

	if !unchanged() {
		return ErrInvalid
	}

	if err := ctx.Err(); err != nil {
		return err
	}
	mapped, err := mapStage(file, int(before.Size()))
	if err != nil {
		return ErrInvalid
	}
	defer mapped.Close()
	data := mapped.Bytes()
	block, err := aes.NewCipher(request.Key)
	if err != nil {
		return ErrInvalid
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return ErrInvalid
	}

	if request.Mode == "encrypt" {
		sealed := gcm.Seal(data[:0], request.Nonce, data[:int(request.Bytes)], request.AAD)
		if len(sealed) != len(data) {
			clear(data)
			_ = mapped.Flush()
			return ErrInvalid
		}
	} else {
		plaintext, err := gcm.Open(data[:0], request.Nonce, data, request.AAD)
		if err != nil || int64(len(plaintext)) != request.Bytes {
			clear(data)
			_ = mapped.Flush()
			return ErrInvalid
		}
		clear(data[int(request.Bytes):])
	}

	if err := ctx.Err(); err != nil {
		clear(data)
		_ = mapped.Flush()
		return err
	}

	if !unchanged() {
		clear(data)
		_ = mapped.Flush()
		return ErrSourceChanged
	}

	if err := mapped.Flush(); err != nil {
		return ErrInvalid
	}

	if err := file.Sync(); err != nil {
		return ErrInvalid
	}

	if err := mapped.Close(); err != nil {
		return ErrInvalid
	}

	if request.Mode == "decrypt" {
		if err := file.Truncate(request.Bytes); err != nil {
			return ErrInvalid
		}
	}

	if err := file.Sync(); err != nil {
		return ErrInvalid
	}
	count := request.Bytes
	if request.Mode == "encrypt" {
		count += gcmTagBytes
	}

	return json.NewEncoder(output).Encode(TransformReceipt{OK: true, Bytes: count})
}

// Transform runs crypto in the current binary's short-lived transform role. The
// caller owns staging and removes it on every failure, including process death.
func Transform(ctx context.Context, executable string, request TransformRequest) error {
	if !filepath.IsAbs(executable) {
		return ErrInvalid
	}
	raw, err := json.Marshal(request)
	if err != nil || len(raw) > TransformRequestMaxBytes {
		return ErrInvalid
	}
	defer clear(raw)
	output, err := platform.Run(ctx, executable, []string{"--role=backup-transform"}, bytes.NewReader(raw))
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrInvalid
	}

	if len(output) > 256 {
		return ErrInvalid
	}
	var receipt TransformReceipt
	if json.Unmarshal(output, &receipt) != nil || !receipt.OK {
		return ErrInvalid
	}
	expected := request.Bytes
	if request.Mode == "encrypt" {
		expected += gcmTagBytes
	}

	if receipt.Bytes != expected {
		return ErrInvalid
	}

	return nil
}

// stageName is deliberately not a caller-selected output path.
func stageName(directory, id string) (string, error) {
	if !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(id) {
		return "", ErrInvalid
	}

	return filepath.Join(directory, ".dant-transform-"+strings.ToLower(id)+".stage"), nil
}
