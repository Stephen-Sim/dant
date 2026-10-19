package security

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/google/uuid"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

const (
	VaultEntryLimit    = 100
	VaultKeyBytes      = 32
	VaultNonceBytes    = 12
	VaultTagBytes      = 16
	VaultMaxFileBytes  = 2 * 1024 * 1024
	VaultAAD           = "dant.credentials.v1"
	RedactedCredential = "[credential redacted]"

	credentialNameUnits    = 100
	credentialServiceUnits = 200
	credentialUserUnits    = 300
	credentialSecretUnits  = 16384
	credentialQueryUnits   = 300
	credentialSearchLimit  = 50
)

var (
	ErrVault             = errors.New("credential_storage_unavailable")
	ErrCredential        = errors.New("invalid_credential")
	ErrCredentialMissing = errors.New("credential_not_found")
	ErrVaultFull         = errors.New("credential_vault_full")
	credentialID         = regexp.MustCompile(`(?i)^[0-9a-f-]{36}$`)
)

type CredentialMetadata struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Service   string  `json:"service"`
	Username  string  `json:"username"`
	CreatedAt float64 `json:"createdAt"`
	UpdatedAt float64 `json:"updatedAt"`
}

type Credential struct {
	CredentialMetadata
	Secret string `json:"secret"`
}

type CredentialInput struct {
	ID       *string `json:"id,omitempty"`
	Name     *string `json:"name,omitempty"`
	Service  *string `json:"service,omitempty"`
	Username *string `json:"username,omitempty"`
	Secret   *string `json:"secret,omitempty"`
}

func (input *CredentialInput) UnmarshalJSON(raw []byte) error {
	object, err := contracts.DecodeObject(raw, VaultMaxFileBytes)
	if err != nil {
		return ErrCredential
	}
	if token, present := object["id"]; present && (string(token) == "null" || !contracts.ValidUnicodeJSON(token)) {
		return ErrCredential
	}
	for _, name := range []string{"name", "service", "username", "secret"} {
		if token, present := object[name]; present && !contracts.ValidUnicodeJSON(token) {
			return ErrCredential
		}
	}
	type decoded CredentialInput
	var value decoded
	if json.Unmarshal(raw, &value) != nil {
		return ErrCredential
	}
	*input = CredentialInput(value)
	return nil
}

type vaultEnvelope struct {
	Version int    `json:"version"`
	IV      string `json:"iv"`
	Tag     string `json:"tag"`
	Data    string `json:"data"`
}

type Vault struct {
	directory string
	file      string
	keyFile   string
	gate      chan struct{}
	now       func() time.Time
}

func NewVault(dataDirectory string) (*Vault, error) {
	if !filepath.IsAbs(dataDirectory) {
		return nil, files.ErrManagedPath
	}
	directory := filepath.Join(dataDirectory, "credentials")
	return &Vault{
		directory: directory,
		file:      filepath.Join(directory, "vault.enc"),
		keyFile:   filepath.Join(directory, "master.key"),
		gate:      make(chan struct{}, 1),
		now:       time.Now,
	}, nil
}

func (vault *Vault) acquire(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case vault.gate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (vault *Vault) prepare() error {
	if _, err := files.OrdinaryDirectory(vault.directory, true); err != nil {
		return ErrVault
	}
	info, err := os.Lstat(vault.directory)
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return ErrVault
	}
	return nil
}

func (vault *Vault) privateFile(name string, limit int64) ([]byte, error) {
	info, err := os.Lstat(name)
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return nil, ErrVault
	}
	data, err := files.ReadRegular(name, limit)
	if err != nil {
		return nil, ErrVault
	}
	return data, nil
}

func (vault *Vault) key(create bool) ([]byte, error) {
	if err := vault.prepare(); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(vault.keyFile); errors.Is(err, fs.ErrNotExist) {
		if !create {
			return nil, ErrVault
		}
		if _, err := os.Lstat(vault.file); !errors.Is(err, fs.ErrNotExist) {
			return nil, ErrVault
		}
		key := make([]byte, VaultKeyBytes)
		if _, err := rand.Read(key); err != nil {
			return nil, ErrVault
		}
		defer clear(key)
		file, err := os.OpenFile(vault.keyFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, ErrVault
		}
		_, writeErr := file.Write(key)
		if writeErr == nil {
			writeErr = file.Sync()
		}
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			return nil, ErrVault
		}
	}
	key, err := vault.privateFile(vault.keyFile, VaultKeyBytes)
	if err != nil || len(key) != VaultKeyBytes {
		clear(key)
		return nil, ErrVault
	}
	return key, nil
}

func (vault *Vault) read() ([]Credential, error) {
	if err := vault.prepare(); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(vault.file); errors.Is(err, fs.ErrNotExist) {
		return []Credential{}, nil
	}
	data, err := vault.privateFile(vault.file, VaultMaxFileBytes)
	if err != nil {
		return nil, ErrVault
	}
	key, err := vault.key(false)
	if err != nil {
		return nil, ErrVault
	}
	defer clear(key)
	if _, err := contracts.DecodeObject(data, VaultMaxFileBytes); err != nil {
		return nil, ErrVault
	}
	var envelope vaultEnvelope
	if json.Unmarshal(data, &envelope) != nil || envelope.Version != 1 {
		return nil, ErrVault
	}
	decode := base64.StdEncoding.Strict().DecodeString
	iv, ivErr := decode(envelope.IV)
	tag, tagErr := decode(envelope.Tag)
	ciphertext, dataErr := decode(envelope.Data)
	if ivErr != nil || tagErr != nil || dataErr != nil || len(iv) != VaultNonceBytes || len(tag) != VaultTagBytes {
		return nil, ErrVault
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrVault
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrVault
	}
	plain, err := gcm.Open(nil, iv, append(ciphertext, tag...), []byte(VaultAAD))
	if err != nil {
		return nil, ErrVault
	}
	defer clear(plain)
	var rawEntries []json.RawMessage
	if json.Unmarshal(plain, &rawEntries) != nil || rawEntries == nil || len(rawEntries) > VaultEntryLimit {
		return nil, ErrVault
	}
	entries := make([]Credential, 0, len(rawEntries))
	for _, raw := range rawEntries {
		object, err := contracts.DecodeObject(raw, VaultMaxFileBytes)
		if err != nil {
			return nil, ErrVault
		}
		for _, name := range []string{"id", "name", "service", "username", "secret"} {
			token := object[name]
			if len(token) < 2 || token[0] != '"' || !contracts.ValidUnicodeJSON(token) {
				return nil, ErrVault
			}
		}
		for _, name := range []string{"createdAt", "updatedAt"} {
			token := object[name]
			if len(token) == 0 || string(token) == "null" {
				return nil, ErrVault
			}
		}
		var entry Credential
		if json.Unmarshal(raw, &entry) != nil {
			return nil, ErrVault
		}
		if !credentialID.MatchString(entry.ID) || math.IsNaN(entry.CreatedAt) || math.IsInf(entry.CreatedAt, 0) || math.IsNaN(entry.UpdatedAt) || math.IsInf(entry.UpdatedAt, 0) {
			return nil, ErrVault
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func (vault *Vault) write(ctx context.Context, entries []Credential) error {
	if len(entries) > VaultEntryLimit {
		return ErrVaultFull
	}
	key, err := vault.key(true)
	if err != nil {
		return ErrVault
	}
	defer clear(key)
	plain, err := json.Marshal(entries)
	if err != nil {
		return ErrVault
	}
	defer clear(plain)
	block, err := aes.NewCipher(key)
	if err != nil {
		return ErrVault
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return ErrVault
	}
	iv := make([]byte, VaultNonceBytes)
	if _, err := rand.Read(iv); err != nil {
		return ErrVault
	}
	encrypted := gcm.Seal(nil, iv, plain, []byte(VaultAAD))
	boundary := len(encrypted) - VaultTagBytes
	envelope := vaultEnvelope{
		Version: 1,
		IV:      base64.StdEncoding.EncodeToString(iv),
		Data:    base64.StdEncoding.EncodeToString(encrypted[:boundary]),
		Tag:     base64.StdEncoding.EncodeToString(encrypted[boundary:]),
	}
	data, err := json.Marshal(envelope)
	if err != nil || len(data) > VaultMaxFileBytes {
		return ErrVault
	}
	if err := files.WriteAtomic(ctx, vault.file, data, 0o600); err != nil {
		return ErrVault
	}
	return nil
}

func (vault *Vault) List(ctx context.Context) ([]CredentialMetadata, error) {
	if err := vault.acquire(ctx); err != nil {
		return nil, err
	}
	defer func() { <-vault.gate }()
	entries, err := vault.read()
	if err != nil {
		return nil, err
	}
	result := make([]CredentialMetadata, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry.CredentialMetadata)
	}
	return result, nil
}

func (vault *Vault) Get(ctx context.Context, id string) (Credential, error) {
	if !credentialID.MatchString(id) {
		return Credential{}, ErrCredential
	}
	if err := vault.acquire(ctx); err != nil {
		return Credential{}, err
	}
	defer func() { <-vault.gate }()
	entries, err := vault.read()
	if err != nil {
		return Credential{}, err
	}
	for _, entry := range entries {
		if entry.ID == id {
			return entry, nil
		}
	}
	return Credential{}, ErrCredentialMissing
}

func validCredentialField(value string, max int, required bool) bool {
	return contracts.UTF16Length(value) <= max && !strings.ContainsRune(value, 0) && (!required || contracts.TrimText(value) != "")
}

func (vault *Vault) Upsert(ctx context.Context, input CredentialInput) (CredentialMetadata, error) {
	if err := vault.acquire(ctx); err != nil {
		return CredentialMetadata{}, err
	}
	defer func() { <-vault.gate }()
	entries, err := vault.read()
	if err != nil {
		return CredentialMetadata{}, err
	}
	index := -1
	var entry Credential
	if input.ID != nil {
		if !credentialID.MatchString(*input.ID) {
			return CredentialMetadata{}, ErrCredential
		}
		for i, stored := range entries {
			if stored.ID == *input.ID {
				index = i
				entry = stored
				break
			}
		}
		if index < 0 {
			return CredentialMetadata{}, ErrCredentialMissing
		}
	}
	if input.Name != nil {
		entry.Name = *input.Name
	}
	if input.Service != nil {
		entry.Service = *input.Service
	}
	if input.Username != nil {
		entry.Username = *input.Username
	}
	if input.Secret != nil {
		entry.Secret = *input.Secret
	}
	if !validCredentialField(entry.Name, credentialNameUnits, true) ||
		!validCredentialField(entry.Service, credentialServiceUnits, false) ||
		!validCredentialField(entry.Username, credentialUserUnits, false) ||
		!validCredentialField(entry.Secret, credentialSecretUnits, true) {
		return CredentialMetadata{}, ErrCredential
	}
	entry.Name, entry.Service = contracts.TrimText(entry.Name), contracts.TrimText(entry.Service)
	entry.UpdatedAt = float64(vault.now().UnixMilli())
	if index < 0 {
		if len(entries) >= VaultEntryLimit {
			return CredentialMetadata{}, ErrVaultFull
		}
		id, err := uuid.NewRandom()
		if err != nil {
			return CredentialMetadata{}, ErrVault
		}
		entry.ID = id.String()
		entry.CreatedAt = entry.UpdatedAt
		entries = append(entries, entry)
	} else {
		entries[index] = entry
	}
	if err := vault.write(ctx, entries); err != nil {
		return CredentialMetadata{}, err
	}
	return entry.CredentialMetadata, nil
}

type RemovedCredential struct {
	Removed bool   `json:"removed"`
	ID      string `json:"id"`
}

func (vault *Vault) Remove(ctx context.Context, id string) (RemovedCredential, error) {
	if !credentialID.MatchString(id) {
		return RemovedCredential{}, ErrCredential
	}
	if err := vault.acquire(ctx); err != nil {
		return RemovedCredential{}, err
	}
	defer func() { <-vault.gate }()
	entries, err := vault.read()
	if err != nil {
		return RemovedCredential{}, err
	}
	filtered := make([]Credential, 0, len(entries))
	for _, entry := range entries {
		if entry.ID != id {
			filtered = append(filtered, entry)
		}
	}
	if len(entries) == len(filtered) {
		return RemovedCredential{}, ErrCredentialMissing
	}
	if err := vault.write(ctx, filtered); err != nil {
		return RemovedCredential{}, err
	}
	return RemovedCredential{Removed: true, ID: id}, nil
}

func (vault *Vault) Find(ctx context.Context, query string) ([]CredentialMetadata, error) {
	if !validCredentialField(query, credentialQueryUnits, false) {
		return nil, ErrCredential
	}
	entries, err := vault.List(ctx)
	if err != nil {
		return nil, err
	}
	query = contracts.TrimText(foldCredential(query))
	result := make([]CredentialMetadata, 0)
	for _, entry := range entries {
		if strings.Contains(foldCredential(entry.Name), query) ||
			strings.Contains(foldCredential(entry.Service), query) ||
			strings.Contains(foldCredential(entry.Username), query) {
			result = append(result, entry)
			if len(result) == credentialSearchLimit {
				break
			}
		}
	}
	return result, nil
}

func foldCredential(value string) string {
	// A Caser may retain transform state; each caller owns its instance.
	return cases.Lower(language.Und).String(value)
}

func (vault *Vault) secretValues(ctx context.Context) ([]string, error) {
	if err := vault.acquire(ctx); err != nil {
		return nil, err
	}
	defer func() { <-vault.gate }()
	entries, err := vault.read()
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry.Secret)
	}
	return result, nil
}

func (vault *Vault) ContainsSecret(ctx context.Context, text string) (bool, error) {
	secrets, err := vault.secretValues(ctx)
	if err != nil {
		return false, err
	}
	for _, secret := range secrets {
		if len(utf16.Encode([]rune(secret))) >= 4 && strings.Contains(text, secret) {
			return true, nil
		}
	}
	return false, nil
}

func (vault *Vault) Redact(ctx context.Context, text string, partial bool, additional []string) (string, error) {
	secrets, err := vault.secretValues(ctx)
	if err != nil {
		return "", err
	}
	return RedactCredentialText(text, append(secrets, additional...), partial), nil
}

func RedactCredentialText(text string, secrets []string, partial bool) string {
	secrets = append([]string(nil), secrets...)
	sort.SliceStable(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	for _, secret := range secrets {
		pattern := utf16.Encode([]rune(secret))
		if len(pattern) < 4 {
			continue
		}
		text = strings.ReplaceAll(text, secret, RedactedCredential)
		if partial {
			units := utf16.Encode([]rune(text))
			count := matchingSuffix(units, pattern)
			if count >= 4 {
				text = string(utf16.Decode(units[:len(units)-count])) + RedactedCredential
			}
		}
	}
	return text
}

func matchingSuffix(text, pattern []uint16) int {
	table := make([]int, len(pattern))
	for i, j := 1, 0; i < len(pattern); i++ {
		for j > 0 && pattern[i] != pattern[j] {
			j = table[j-1]
		}
		if pattern[i] == pattern[j] {
			j++
		}
		table[i] = j
	}
	if len(text) > len(pattern) {
		text = text[len(text)-len(pattern):]
	}
	matched := 0
	for _, unit := range text {
		for matched > 0 && unit != pattern[matched] {
			matched = table[matched-1]
		}
		if unit == pattern[matched] {
			matched++
		}
		if matched == len(pattern) {
			matched = table[matched-1]
		}
	}
	return matched
}
