package security

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const (
	MinAPIKeyBytes        = 16
	MaxAPIKeyBytes        = 4096
	MaxProtectedBlobBytes = 64 * 1024
	VoiceKeyFileName      = "voice-key.dpapi"
	VoiceKeyEntropy       = "dant.voice-key.dpapi.v1"
)

var (
	ErrAPIKey           = errors.New("invalid_api_key")
	ErrSecretProtection = errors.New("secret_protection_unavailable")
	ErrStoredVoiceKey   = errors.New("protected_voice_key_unavailable")
)

type Protector interface {
	Protect(context.Context, []byte) ([]byte, error)
	Unprotect(context.Context, []byte) ([]byte, error)
}

type KeyStatus struct {
	Configured bool    `json:"configured"`
	Source     *string `json:"source"`
	Storage    string  `json:"storage"`
}

type VoiceKeyStore struct {
	gate        chan struct{}
	file        string
	platform    string
	environment string
	protector   Protector
}

func ValidateAPIKey(value string) (string, error) {
	value = contracts.TrimText(value)
	if len(value) < MinAPIKeyBytes || len(value) > MaxAPIKeyBytes {
		return "", ErrAPIKey
	}
	for _, character := range value {
		if character < 0x21 || character > 0x7e {
			return "", ErrAPIKey
		}
	}
	return value, nil
}

// NewVoiceKeyStore captures configuration once. Missing .env is supported;
// neither the example file nor a credential placeholder is loaded as a key.
func NewVoiceKeyStore(dataDirectory, platform, environmentKey string, protector Protector) (*VoiceKeyStore, error) {
	if !filepath.IsAbs(dataDirectory) {
		return nil, files.ErrManagedPath
	}
	return &VoiceKeyStore{
		gate:        make(chan struct{}, 1),
		file:        filepath.Join(dataDirectory, VoiceKeyFileName),
		platform:    platform,
		environment: environmentKey,
		protector:   protector,
	}, nil
}

func (store *VoiceKeyStore) acquire(ctx context.Context) error {
	select {
	case store.gate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (store *VoiceKeyStore) stored() (bool, error) {
	if store.platform != "windows" && store.platform != "win32" {
		return false, nil
	}
	info, err := os.Lstat(store.file)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > MaxProtectedBlobBytes {
		return false, ErrStoredVoiceKey
	}
	return true, nil
}

func (store *VoiceKeyStore) Status() (KeyStatus, error) {
	return store.status()
}

func (store *VoiceKeyStore) status() (KeyStatus, error) {
	stored, err := store.stored()
	if err != nil {
		return KeyStatus{}, err
	}
	status := KeyStatus{Storage: "environment"}
	if store.platform == "windows" || store.platform == "win32" {
		status.Storage = "windows-dpapi"
	}
	if stored {
		source := "stored"
		status.Source = &source
		status.Configured = true
	} else if _, err := ValidateAPIKey(store.environment); err == nil {
		source := "environment"
		status.Source = &source
		status.Configured = true
	}
	return status, nil
}

func (store *VoiceKeyStore) Get(ctx context.Context) (string, error) {
	if err := store.acquire(ctx); err != nil {
		return "", err
	}
	defer func() { <-store.gate }()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	stored, err := store.stored()
	if err != nil {
		return "", err
	}
	if !stored {
		if store.environment == "" {
			return "", nil
		}
		return ValidateAPIKey(store.environment)
	}
	if store.protector == nil {
		return "", ErrSecretProtection
	}
	blob, err := files.ReadRegular(store.file, MaxProtectedBlobBytes)
	if err != nil {
		return "", ErrStoredVoiceKey
	}
	defer clear(blob)
	plain, err := store.protector.Unprotect(ctx, blob)
	if err != nil {
		return "", ErrStoredVoiceKey
	}
	defer clear(plain)
	key, err := ValidateAPIKey(string(plain))
	if err != nil {
		return "", ErrStoredVoiceKey
	}
	return key, nil
}

func (store *VoiceKeyStore) Set(ctx context.Context, value string) (KeyStatus, error) {
	key, err := ValidateAPIKey(value)
	if err != nil {
		return KeyStatus{}, err
	}
	if err := store.acquire(ctx); err != nil {
		return KeyStatus{}, err
	}
	defer func() { <-store.gate }()
	if (store.platform != "windows" && store.platform != "win32") || store.protector == nil {
		return KeyStatus{}, ErrSecretProtection
	}
	plain := []byte(key)
	defer clear(plain)
	blob, err := store.protector.Protect(ctx, plain)
	if err != nil || len(blob) < 1 || len(blob) > MaxProtectedBlobBytes {
		return KeyStatus{}, ErrSecretProtection
	}
	defer clear(blob)
	if err := files.WriteAtomic(ctx, store.file, blob, 0o600); err != nil {
		return KeyStatus{}, ErrStoredVoiceKey
	}
	return store.status()
}

func (store *VoiceKeyStore) Clear(ctx context.Context) (KeyStatus, error) {
	if err := store.acquire(ctx); err != nil {
		return KeyStatus{}, err
	}
	defer func() { <-store.gate }()
	if err := ctx.Err(); err != nil {
		return KeyStatus{}, err
	}
	if _, err := files.OrdinaryDirectory(filepath.Dir(store.file), false); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return KeyStatus{}, ErrStoredVoiceKey
	}
	if _, err := os.Lstat(store.file); err == nil {
		if _, err := files.ReadRegular(store.file, MaxProtectedBlobBytes); err != nil {
			return KeyStatus{}, ErrStoredVoiceKey
		}
		if err := os.Remove(store.file); err != nil {
			return KeyStatus{}, ErrStoredVoiceKey
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return KeyStatus{}, ErrStoredVoiceKey
	}
	return store.status()
}
