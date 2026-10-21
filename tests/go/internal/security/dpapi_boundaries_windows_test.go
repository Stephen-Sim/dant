package security

import (
	"context"
	"errors"
	"testing"

	"golang.org/x/sys/windows"
)

func TestDPAPIBoundsRejectInvalidNativeBuffersWithoutReturningPrivateBytes(t *testing.T) {
	if value := blob(nil); value.Size != 0 || value.Data != nil {
		t.Fatal("empty input exposed a native memory pointer")
	}
	if value, err := protectedBytes(windows.DataBlob{}, 4); value != nil || !errors.Is(err, ErrSecretProtection) {
		t.Fatal("missing native allocation was accepted", err)
	}
	for _, fixture := range []struct {
		size  uint32
		limit int
	}{{0, 4}, {4, 3}} {
		input, entropy, output := blob([]byte("synthetic-native-buffer")), blob([]byte(VoiceKeyEntropy)), windows.DataBlob{}
		if err := windows.CryptProtectData(&input, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
			t.Fatal(err)
		}
		if output.Size < 4 {
			_, _ = protectedBytes(output, -1)
			t.Fatal("synthetic native allocation was unexpectedly small")
		}
		output.Size = fixture.size
		value, err := protectedBytes(output, fixture.limit)
		if value != nil || !errors.Is(err, ErrSecretProtection) {
			t.Fatal("out-of-policy native allocation escaped protection", err)
		}
	}
	protector := NativeProtector()
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := protector.Protect(cancelled, []byte("synthetic-protection-token")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := protector.Unprotect(cancelled, []byte("synthetic-blob")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	for _, value := range [][]byte{nil, make([]byte, MaxAPIKeyBytes+1)} {
		if result, err := protector.Protect(t.Context(), value); result != nil || !errors.Is(err, ErrSecretProtection) {
			t.Fatal("out-of-policy plaintext reached the OS", err)
		}
	}
	for _, value := range [][]byte{nil, make([]byte, MaxProtectedBlobBytes+1)} {
		if result, err := protector.Unprotect(t.Context(), value); result != nil || !errors.Is(err, ErrSecretProtection) {
			t.Fatal("out-of-policy ciphertext reached the OS", err)
		}
	}
}
