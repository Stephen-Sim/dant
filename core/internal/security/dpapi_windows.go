package security

import (
	"context"
	"unsafe"

	"golang.org/x/sys/windows"
)

type DPAPI struct{}

func NativeProtector() Protector { return DPAPI{} }

func blob(value []byte) windows.DataBlob {
	if len(value) == 0 {
		return windows.DataBlob{}
	}
	return windows.DataBlob{Size: uint32(len(value)), Data: &value[0]}
}

func protectedBytes(output windows.DataBlob, limit int) ([]byte, error) {
	if output.Data == nil {
		return nil, ErrSecretProtection
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	// Size describes the allocation returned by Windows, rather than an
	// untrusted file length. Wipe it even when the policy limit rejects it.
	source := unsafe.Slice(output.Data, int(output.Size))
	defer clear(source)
	if output.Size == 0 || uint64(output.Size) > uint64(limit) {
		return nil, ErrSecretProtection
	}
	return append([]byte(nil), source...), nil
}

func (DPAPI) Protect(ctx context.Context, plain []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(plain) < MinAPIKeyBytes || len(plain) > MaxAPIKeyBytes {
		return nil, ErrSecretProtection
	}
	input, entropy, output := blob(plain), blob([]byte(VoiceKeyEntropy)), windows.DataBlob{}
	if err := windows.CryptProtectData(&input, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
		return nil, ErrSecretProtection
	}
	result, err := protectedBytes(output, MaxProtectedBlobBytes)
	if err == nil && ctx.Err() != nil {
		clear(result)
		return nil, ctx.Err()
	}
	return result, err
}

func (DPAPI) Unprotect(ctx context.Context, encrypted []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(encrypted) < 1 || len(encrypted) > MaxProtectedBlobBytes {
		return nil, ErrSecretProtection
	}
	input, entropy, output := blob(encrypted), blob([]byte(VoiceKeyEntropy)), windows.DataBlob{}
	if err := windows.CryptUnprotectData(&input, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
		return nil, ErrSecretProtection
	}
	result, err := protectedBytes(output, MaxAPIKeyBytes)
	if err == nil && ctx.Err() != nil {
		clear(result)
		return nil, ctx.Err()
	}
	return result, err
}
