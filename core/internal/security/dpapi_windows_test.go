package security

import (
	"bytes"
	"context"
	"testing"
)

func TestWindowsNativeDPAPIRoundTripUsesOnlySyntheticInMemoryCredential(t *testing.T) {
	protector := NativeProtector()
	plain := []byte("fixture-native-protection-key")
	encrypted, err := protector.Protect(context.Background(), plain)
	if err != nil || bytes.Contains(encrypted, plain) {
		t.Fatal("native DPAPI did not protect fixture bytes")
	}
	decrypted, err := protector.Unprotect(context.Background(), encrypted)
	defer clear(decrypted)
	if err != nil || !bytes.Equal(decrypted, plain) {
		t.Fatal("native DPAPI fixture did not round-trip")
	}
	encrypted[len(encrypted)-1] ^= 1
	if result, err := protector.Unprotect(context.Background(), encrypted); err == nil || len(result) != 0 {
		clear(result)
		t.Fatal("tampered DPAPI fixture was accepted")
	}
}
