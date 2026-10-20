package computer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

const profileLimit = 64

type Profile struct {
	ID        string                 `json:"id"`
	Label     string                 `json:"label"`
	Directory string                 `json:"directory"`
	Host      string                 `json:"host"`
	User      string                 `json:"user"`
	Port      int                    `json:"port"`
	Source    string                 `json:"source"`
	Provider  contracts.VmProviderId `json:"provider,omitempty"`
	Name      string                 `json:"name,omitempty"`
	VMXPath   string                 `json:"vmxPath,omitempty"`
	VMwareID  string                 `json:"vmwareId,omitempty"`
}

type ProfileDiscovery struct {
	Current           *Profile  `json:"current"`
	Candidates        []Profile `json:"candidates"`
	RequiresSelection bool      `json:"requiresSelection"`
	Error             *string   `json:"error"`
	RegistryError     *string   `json:"registryError"`
}

type registryProfile struct {
	Directory    string          `json:"directory"`
	RegisteredAt json.RawMessage `json:"registeredAt,omitempty"`
}

type profileRegistry struct {
	Version  int               `json:"version"`
	Owner    string            `json:"owner"`
	Profiles []registryProfile `json:"profiles"`
}

type ProfileOptions struct {
	DataDir, ProjectRoot, RegistryFile, Owner string
	CandidateDirs                             []string
	IncludeProject                            bool
	Now                                       func() time.Time
}

type profileSource struct{ directory, source string }
type Profiles struct {
	mu            sync.Mutex
	options       ProfileOptions
	sources       []profileSource
	registryError *string
}

func DefaultProfileRegistry(home string, environment map[string]string) string {
	if runtime.GOOS == "windows" {
		base := environment["LOCALAPPDATA"]
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "dant", "vm-profiles.json")
	}

	return filepath.Join(home, ".local", "share", "dant", "vm-profiles.json")
}

func CurrentProfileOwner() (string, error) {
	account, err := user.Current()
	if err != nil {
		return "", ErrBinding
	}
	uid := int64(-1)
	username := account.Username
	if runtime.GOOS != "windows" {
		uid, err = strconv.ParseInt(account.Uid, 10, 64)
		if err != nil {
			return "", ErrBinding
		}
	} else if index := strings.LastIndex(username, `\`); index >= 0 {
		username = username[index+1:]
	}
	value := `{"name":` + canonicalJSONString(username) + `,"home":` + canonicalJSONString(account.HomeDir) + `,"uid":` + strconv.FormatInt(uid, 10) + `}`
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:]), nil
}

func NewProfiles(options ProfileOptions) (*Profiles, error) {
	if !filepath.IsAbs(options.DataDir) || !filepath.IsAbs(options.ProjectRoot) || options.Owner == "" || (options.RegistryFile != "" && !filepath.IsAbs(options.RegistryFile)) {
		return nil, ErrBinding
	}

	if options.Now == nil {
		options.Now = time.Now
	}
	profiles := &Profiles{options: options}
	for _, directory := range options.CandidateDirs {
		if len(profiles.sources) >= profileLimit {
			break
		}
		if filepath.IsAbs(directory) && !strings.ContainsRune(directory, 0) {
			profiles.sources = append(profiles.sources, profileSource{directory, "selected"})
		}
	}

	if options.IncludeProject {
		profiles.sources = append(profiles.sources, profileSource{filepath.Join(options.ProjectRoot, "data"), "workspace"})
	}

	return profiles, nil
}

func canonicalProfile(directory string) string {
	value, err := filepath.EvalSymlinks(directory)
	if err == nil {
		return value
	}

	return filepath.Clean(directory)
}

func (profiles *Profiles) descriptor(directory, source string) (Profile, Binding, error) {
	binding, err := ReadBinding(directory)
	if err != nil {
		return Profile{}, Binding{}, err
	}
	resolved := canonicalProfile(directory)
	key := `[` + canonicalJSONString(strings.ToLower(binding.Host)) + `,` + canonicalJSONString(binding.User) + `,` + strconv.Itoa(binding.Port) + `,` + canonicalJSONString(binding.KeyPath) + `]`
	sum := sha256.Sum256([]byte(key))
	return Profile{
		ID:        hex.EncodeToString(sum[:])[:24],
		Label:     filepath.Base(resolved),
		Directory: resolved,
		Host:      binding.Host,
		User:      binding.User,
		Port:      binding.Port,
		Source:    source,
		Provider:  binding.Provider,
		Name:      binding.Name,
		VMXPath:   binding.VMXPath,
		VMwareID:  binding.VMwareID,
	}, binding, nil
}

func (profiles *Profiles) registry() profileRegistry {
	empty := profileRegistry{Version: 1, Owner: profiles.options.Owner, Profiles: []registryProfile{}}
	if profiles.options.RegistryFile == "" {
		return empty
	}
	raw, err := files.ReadRegular(profiles.options.RegistryFile, bindingMaxBytes)
	if errors.Is(err, os.ErrNotExist) {
		return empty
	}
	var registry profileRegistry
	_, decodeErr := contracts.DecodeObject(raw, bindingMaxBytes)
	if err != nil || decodeErr != nil || json.Unmarshal(raw, &registry) != nil || registry.Version != 1 || registry.Owner != profiles.options.Owner || registry.Profiles == nil {
		message := "The current user profile registry could not be read and was ignored."
		profiles.registryError = &message
		return empty
	}
	valid := []registryProfile{}
	for _, profile := range registry.Profiles {
		if filepath.IsAbs(profile.Directory) && !strings.ContainsRune(profile.Directory, 0) {
			valid = append(valid, profile)
			if len(valid) >= profileLimit {
				break
			}
		}
	}
	registry.Profiles = valid
	return registry
}

func (profiles *Profiles) discoverLocked() ProfileDiscovery {
	result := ProfileDiscovery{Candidates: []Profile{}}
	current, _, err := profiles.descriptor(profiles.options.DataDir, "current")
	if err == nil {
		result.Current = &current
	} else {
		message := "No valid VM connection is configured."
		result.Error = &message
	}
	registry := profiles.registry()
	sources := append([]profileSource{}, profiles.sources...)
	for _, profile := range registry.Profiles {
		sources = append(sources, profileSource{profile.Directory, "registry"})
	}
	directories := map[string]bool{canonicalProfile(profiles.options.DataDir): true}
	bindings := map[string]bool{}
	if result.Current != nil {
		bindings[result.Current.ID] = true
	}
	for _, source := range sources {
		directory := canonicalProfile(source.directory)
		if directories[directory] {
			continue
		}
		directories[directory] = true
		profile, _, err := profiles.descriptor(directory, source.source)
		if err != nil || bindings[profile.ID] {
			continue
		}
		bindings[profile.ID] = true
		result.Candidates = append(result.Candidates, profile)
	}
	result.RequiresSelection = result.Current == nil && len(result.Candidates) > 1
	if result.RequiresSelection {
		message := "Several existing VM connections were found. Choose the one to import."
		result.Error = &message
	}

	if profiles.registryError != nil {
		message := *profiles.registryError
		result.RegistryError = &message
	}

	return result
}

func (profiles *Profiles) Discover() ProfileDiscovery {
	profiles.mu.Lock()
	defer profiles.mu.Unlock()
	return profiles.discoverLocked()
}

func (profiles *Profiles) registerLocked(ctx context.Context) error {
	current, _, err := profiles.descriptor(profiles.options.DataDir, "current")
	if err != nil {
		return err
	}

	if profiles.options.RegistryFile == "" {
		return nil
	}
	registry := profiles.registry()
	if profiles.registryError != nil {
		return nil
	}
	entries := []registryProfile{{Directory: current.Directory, RegisteredAt: json.RawMessage(strconv.FormatInt(profiles.options.Now().UnixMilli(), 10))}}
	for _, profile := range registry.Profiles {
		if canonicalProfile(profile.Directory) != current.Directory {
			entries = append(entries, profile)
			if len(entries) >= profileLimit {
				break
			}
		}
	}
	registry.Profiles = entries
	if _, err := files.OrdinaryDirectory(filepath.Dir(profiles.options.RegistryFile), true); err != nil {
		return ErrBinding
	}
	raw, _ := json.Marshal(registry)
	return files.WriteAtomic(ctx, profiles.options.RegistryFile, raw, 0600)
}

func (profiles *Profiles) RegisterCurrent(ctx context.Context) error {
	profiles.mu.Lock()
	defer profiles.mu.Unlock()
	return profiles.registerLocked(ctx)
}

type ProfileImport struct {
	ID             string `json:"id,omitempty"`
	Directory      string `json:"directory,omitempty"`
	ReplaceCurrent bool   `json:"replaceCurrent"`
}

type ProfileImported struct {
	OK        bool    `json:"ok"`
	Profile   Profile `json:"profile"`
	Connected bool    `json:"connected"`
}

func (profiles *Profiles) importLocked(ctx context.Context, selection ProfileImport) (ProfileImported, error) {
	if (selection.ID == "") == (selection.Directory == "") {
		return ProfileImported{}, ErrBinding
	}
	current, _, currentErr := profiles.descriptor(profiles.options.DataDir, "current")
	if selection.ID != "" && currentErr == nil && selection.ID == current.ID {
		return ProfileImported{OK: true, Profile: current}, nil
	}
	directory := selection.Directory
	source := "selected"
	if directory != "" {
		if !filepath.IsAbs(directory) || len(directory) > 4096 || strings.ContainsRune(directory, 0) {
			return ProfileImported{}, ErrBinding
		}
	} else {
		for _, candidate := range profiles.discoverLocked().Candidates {
			if candidate.ID == selection.ID {
				directory = candidate.Directory
				source = candidate.Source
				break
			}
		}
		if directory == "" {
			return ProfileImported{}, ErrBinding
		}
	}
	selected, binding, err := profiles.descriptor(directory, source)
	if err != nil {
		return ProfileImported{}, err
	}

	if currentErr == nil {
		if current.ID == selected.ID {
			return ProfileImported{OK: true, Profile: current}, nil
		}
		if !selection.ReplaceCurrent {
			return ProfileImported{}, ErrBinding
		}
	}

	if _, err := files.OrdinaryDirectory(profiles.options.DataDir, true); err != nil {
		return ProfileImported{}, ErrBinding
	}
	target := filepath.Join(profiles.options.DataDir, "vm.json")
	previous, err := files.ReadRegular(target, bindingMaxBytes)
	if err == nil {
		kind := "invalid"
		if currentErr == nil {
			kind = "previous"
		}
		name := target + "." + kind + "-" + strconv.FormatInt(profiles.options.Now().UnixMilli(), 10) + "-" + operationUUID() + ".bak"
		file, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return ProfileImported{}, ErrBinding
		}
		_, writeErr := file.Write(previous)
		syncErr := file.Sync()
		closeErr := file.Close()
		if writeErr != nil || syncErr != nil || closeErr != nil {
			return ProfileImported{}, ErrBinding
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ProfileImported{}, ErrBinding
	}
	raw, _ := json.Marshal(binding)
	if err := files.WriteAtomic(ctx, target, raw, 0600); err != nil {
		return ProfileImported{}, err
	}

	if err := profiles.registerLocked(ctx); err != nil {
		message := "The VM connection was imported, but its profile could not be registered for other installations."
		profiles.registryError = &message
	}

	return ProfileImported{OK: true, Profile: selected}, nil
}

func (profiles *Profiles) Import(ctx context.Context, selection ProfileImport) (ProfileImported, error) {
	profiles.mu.Lock()
	defer profiles.mu.Unlock()
	return profiles.importLocked(ctx, selection)
}

func (profiles *Profiles) AutoImport(ctx context.Context) (ProfileDiscovery, error) {
	profiles.mu.Lock()
	defer profiles.mu.Unlock()
	discovery := profiles.discoverLocked()
	if discovery.Current != nil {
		if err := profiles.registerLocked(ctx); err != nil {
			message := "The current VM profile could not be registered for other installations."
			profiles.registryError = &message
		}
		return profiles.discoverLocked(), nil
	}

	if len(discovery.Candidates) == 1 {
		if _, err := profiles.importLocked(ctx, ProfileImport{ID: discovery.Candidates[0].ID}); err != nil {
			return discovery, err
		}
	}

	return profiles.discoverLocked(), nil
}
