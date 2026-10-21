package skills

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/google/uuid"
)

type Library struct {
	workspace      string
	enabledRoot    string
	disabledRoot   string
	containsSecret func(context.Context, string) bool
	now            func() time.Time
	storage        libraryStorage
	mu             sync.Mutex
}

type located struct {
	directory string
	enabled   bool
	meta      Metadata
}

func New(workspace string, options Options) (*Library, error) {
	absolute, err := filepath.Abs(workspace)
	if err != nil {
		return nil, invalid()
	}
	if _, err = files.OrdinaryDirectory(absolute, true); err != nil {
		return nil, err
	}

	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Library{
		workspace:      absolute,
		enabledRoot:    filepath.Join(absolute, ".agents", "skills"),
		disabledRoot:   filepath.Join(absolute, ".dant-disabled-skills"),
		containsSecret: options.ContainsSecret,
		now:            now,
		storage:        diskLibraryStorage(),
	}, nil
}

func jsonBytes(value any) []byte {
	result, _ := json.Marshal(value)
	return result
}

func sortedNames[T any](items map[string]T) []string {
	names := make([]string, 0, len(items))
	for name := range items {
		names = append(names, name)
	}

	slices.Sort(names)
	return names
}

func (library *Library) locate(ctx context.Context, name string) (*located, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !namePattern.MatchString(name) {
		return nil, invalid()
	}

	for index, root := range []string{library.enabledRoot, library.disabledRoot} {
		directory := filepath.Join(root, name)
		if _, err := os.Lstat(directory); errors.Is(err, fs.ErrNotExist) {
			continue
		} else if err != nil {
			return nil, err
		}

		managed, err := library.storage.openRoot(directory, false)
		if err != nil {
			return nil, invalid()
		}
		data, err := managed.ReadFile(ctx, markerName, markerBytes)
		_ = managed.Close()
		if err != nil {
			return nil, invalid()
		}
		object, err := contracts.DecodeObject(data, markerBytes)
		var meta Metadata
		if err != nil || json.Unmarshal(data, &meta) != nil || !validMetadata(meta, object, name) {
			return nil, invalid()
		}
		return &located{directory: directory, enabled: index == 0, meta: meta}, nil
	}
	return nil, nil
}

func validMetadata(meta Metadata, object contracts.RawObject, name string) bool {
	return meta.Owner == "dant" && meta.Name == name &&
		len(object["description"]) > 0 && string(object["description"]) != "null" &&
		len(object["updatedAt"]) > 0 && string(object["updatedAt"]) != "null" &&
		!math.IsInf(meta.UpdatedAt, 0) && !math.IsNaN(meta.UpdatedAt)
}

func (library *Library) Exists(ctx context.Context, name string) (bool, error) {
	library.mu.Lock()
	defer library.mu.Unlock()

	found, err := library.locate(ctx, name)
	return found != nil, err
}

func summary(found *located) Summary {
	return Summary{
		Name:        found.meta.Name,
		Description: found.meta.Description,
		Enabled:     found.enabled,
		Path:        filepath.Join(found.directory, "SKILL.md"),
		UpdatedAt:   found.meta.UpdatedAt,
	}
}

func (library *Library) List(ctx context.Context) ([]Summary, error) {
	library.mu.Lock()
	defer library.mu.Unlock()

	result := []Summary{}
	seen := map[string]bool{}
	for _, directory := range []string{library.enabledRoot, library.disabledRoot} {
		managed, err := library.storage.openRoot(directory, false)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		entries, err := managed.ReadDirectory(".")
		_ = managed.Close()
		if err != nil {
			return nil, err
		}
		if len(entries) > TreeEntryLimit {
			return nil, limited()
		}

		for _, entry := range entries {
			if !entry.IsDir() || !namePattern.MatchString(entry.Name()) || seen[entry.Name()] {
				continue
			}
			found, err := library.locate(ctx, entry.Name())
			if err != nil || found == nil {
				continue
			}
			seen[entry.Name()] = true
			result = append(result, summary(found))
		}
	}
	slices.SortFunc(result, func(a, b Summary) int { return strings.Compare(a.Name, b.Name) })
	return result, nil
}

func instructionBody(data []byte) (string, error) {
	if !utf8.Valid(data) || nonText.Match(data) {
		return "", invalid()
	}
	source := strings.TrimPrefix(string(data), "\ufeff")
	if !strings.HasPrefix(source, "---\n") {
		return "", invalid()
	}
	boundary := strings.Index(source[4:], "\n---\n")
	if boundary < 0 {
		return "", invalid()
	}

	value := contracts.TrimText(source[4+boundary+5:])
	if value == "" {
		return "", invalid()
	}
	if len(value) > InstructionBytes {
		return "", limited()
	}
	return value, nil
}

func (library *Library) snapshot(ctx context.Context, name string) (Snapshot, error) {
	found, err := library.locate(ctx, name)
	if err != nil {
		return Snapshot{}, err
	}
	if found == nil {
		return Snapshot{}, missing()
	}

	root, err := library.storage.openRoot(found.directory, false)
	if err != nil {
		return Snapshot{}, err
	}
	defer root.Close()

	data, err := root.ReadFile(ctx, "SKILL.md", FileBytes)
	if err != nil {
		return Snapshot{}, err
	}
	instructions, err := instructionBody(data)
	if err != nil {
		return Snapshot{}, err
	}
	result := Snapshot{
		Summary:      summary(found),
		Instructions: instructions,
		Files:        map[string]string{},
		BinaryFiles:  map[string]BinaryFile{},
	}
	entries, count, total := 0, 0, len(instructions)
	var walk func(string, int) error
	walk = func(directory string, depth int) error {
		if depth > MaxDepth {
			return invalid()
		}
		items, err := root.ReadDirectory(directory)
		if err != nil {
			return err
		}
		for _, entry := range items {
			entries++
			if entries > TreeEntryLimit {
				return limited()
			}
			relative := entry.Name()
			if directory != "." {
				relative = filepath.Join(directory, relative)
			}
			slash := filepath.ToSlash(relative)
			if entry.Type()&fs.ModeSymlink != 0 {
				return invalid()
			}
			if directory == "." && (entry.Name() == "SKILL.md" || entry.Name() == markerName) {
				if !entry.Type().IsRegular() {
					return invalid()
				}
				continue
			}
			if hasControl(slash) {
				return invalid()
			}
			if entry.IsDir() {
				if slices.Contains([]string{"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules"}, entry.Name()) {
					continue
				}
				if !ValidFileName(slash + "/x") {
					return invalid()
				}
				if err := walk(relative, depth+1); err != nil {
					return err
				}
				continue
			}
			if !ValidFileName(slash) {
				return invalid()
			}
			count++
			if count > SupportFileLimit {
				return limited()
			}
			data, err := root.ReadFile(ctx, relative, FileBytes)
			if err != nil {
				return invalid()
			}
			total += len(data)
			if total > TotalBytes {
				return limited()
			}
			if library.secret(ctx, data) {
				return credentials()
			}
			if textFile(data) {
				result.Files[slash] = string(data)
			} else {
				result.BinaryFiles[slash] = BinaryFile{Encoding: "base64", MediaType: "application/octet-stream", Data: base64.StdEncoding.EncodeToString(data)}
			}
		}
		return nil
	}
	if err := walk(".", 0); err != nil {
		return Snapshot{}, err
	}
	return result, nil
}

func (library *Library) ExportSnapshot(ctx context.Context, name string) (Snapshot, error) {
	library.mu.Lock()
	defer library.mu.Unlock()
	return library.snapshot(ctx, name)
}

func view(snapshot Snapshot) View {
	selected, preserved := editable(snapshot)
	assets := []Asset{}
	for _, name := range sortedNames(snapshot.BinaryFiles) {
		data, _ := decodeBinary(snapshot.BinaryFiles[name])
		assets = append(assets, Asset{Path: name, MediaType: "application/octet-stream", Size: len(data)})
	}
	for _, name := range sortedNames(preserved) {
		assets = append(assets, Asset{Path: name, MediaType: "application/octet-stream", Size: len(preserved[name])})
	}
	return View{Summary: snapshot.Summary, Instructions: snapshot.Instructions, Files: selected, Assets: assets}
}

func (library *Library) Get(ctx context.Context, name string) (View, error) {
	snapshot, err := library.ExportSnapshot(ctx, name)
	if err != nil {
		return View{}, err
	}
	return view(snapshot), nil
}

func manifestBytes(name, description, instructions string) []byte {
	return []byte("---\nname: " + string(jsonBytes(name)) + "\ndescription: " + string(jsonBytes(description)) + "\n---\n\n" + instructions + "\n")
}

func validatePaths(output map[string][]byte) error {
	seen := map[string]bool{"skill.md": true}
	for name := range output {
		key := strings.ToLower(name)
		if seen[key] {
			return invalid()
		}
		seen[key] = true
	}
	for name := range seen {
		parts := strings.Split(name, "/")
		for count := 1; count < len(parts); count++ {
			if seen[strings.Join(parts[:count], "/")] {
				return invalid()
			}
		}
	}
	return nil
}

func (library *Library) Save(ctx context.Context, input SaveInput, overwrite bool) (View, error) {
	library.mu.Lock()
	defer library.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return View{}, err
	}

	// Snapshot caller-owned maps before preserving editor assets.
	if input.Files != nil {
		copied := make(map[string]string, len(input.Files))
		for key, value := range input.Files {
			copied[key] = value
		}
		input.Files = copied
	}
	if !namePattern.MatchString(input.Name) ||
		!validText(input.Description, DescriptionBytes) ||
		!validText(input.Instructions, InstructionBytes) {
		return View{}, invalid()
	}

	found, err := library.locate(ctx, input.Name)
	if err != nil {
		return View{}, err
	}
	if found != nil && !overwrite {
		return View{}, exists()
	}
	if input.PreserveBinaryFiles && (found == nil || input.BinaryFiles != nil) {
		return View{}, invalid()
	}

	if found != nil && (input.Files == nil || input.PreserveBinaryFiles) {
		snapshot, err := library.snapshot(ctx, input.Name)
		if err != nil {
			return View{}, err
		}
		if input.Files == nil {
			input.Files = snapshot.Files
		} else if input.PreserveBinaryFiles {
			_, preserved := editable(snapshot)
			for key, value := range preserved {
				if _, ok := input.Files[key]; ok {
					return View{}, invalid()
				}
				input.Files[key] = value
			}
		}
		if input.BinaryFiles == nil {
			input.BinaryFiles = snapshot.BinaryFiles
		}
	}
	if len(input.Files)+len(input.BinaryFiles) > SupportFileLimit {
		return View{}, limited()
	}

	output := map[string][]byte{}
	total := len(input.Instructions)
	for name, value := range input.Files {
		if !ValidFileName(name) || !utf8.ValidString(value) {
			return View{}, invalid()
		}
		output[name] = []byte(value)
	}
	for name, value := range input.BinaryFiles {
		if _, ok := output[name]; ok || !ValidFileName(name) {
			return View{}, invalid()
		}
		data, err := decodeBinary(value)
		if err != nil {
			return View{}, err
		}
		output[name] = data
	}
	if err := validatePaths(output); err != nil {
		return View{}, err
	}

	for name, data := range output {
		total += len(data)
		if len(data) > FileBytes || total > TotalBytes {
			return View{}, limited()
		}
		if library.secret(ctx, []byte(name)) || library.secret(ctx, data) {
			return View{}, credentials()
		}
	}
	for _, text := range []string{input.Name, input.Description, input.Instructions} {
		if library.secret(ctx, []byte(text)) {
			return View{}, credentials()
		}
	}

	enabled := true
	if found != nil {
		enabled = found.enabled
	}
	if input.Enabled != nil {
		enabled = *input.Enabled
	}

	rootName := library.enabledRoot
	if !enabled {
		rootName = library.disabledRoot
	}
	if _, err := files.OrdinaryDirectory(rootName, true); err != nil {
		return View{}, err
	}
	destination := filepath.Join(rootName, input.Name)
	if found != nil && found.directory != destination {
		if _, err := os.Lstat(destination); !errors.Is(err, fs.ErrNotExist) {
			return View{}, exists()
		}
	}
	temporary := filepath.Join(rootName, ".staging-"+uuid.NewString())
	backup := filepath.Join(rootName, ".backup-"+uuid.NewString())
	if err := os.Mkdir(temporary, 0o700); err != nil {
		return View{}, err
	}
	defer library.storage.removeStaging(rootName, temporary)

	description, instructions := contracts.TrimText(input.Description), contracts.TrimText(input.Instructions)
	if err := library.storage.writeAtomic(ctx, filepath.Join(temporary, "SKILL.md"), manifestBytes(input.Name, description, instructions), 0o600); err != nil {
		return View{}, err
	}
	for _, name := range sortedNames(output) {
		target := filepath.Join(temporary, filepath.FromSlash(name))
		if _, err := files.OrdinaryDirectory(filepath.Dir(target), true); err != nil {
			return View{}, err
		}
		if err := library.storage.writeAtomic(ctx, target, output[name], 0o600); err != nil {
			return View{}, err
		}
	}
	meta := Metadata{
		Owner:       "dant",
		Name:        input.Name,
		Description: description,
		Files:       sortedNames(output),
		UpdatedAt:   float64(library.now().UnixMilli()),
	}
	if err := library.storage.writeAtomic(ctx, filepath.Join(temporary, markerName), jsonBytes(meta), 0o600); err != nil {
		return View{}, err
	}

	moved := false
	if found != nil {
		if err := library.storage.rename(ctx, found.directory, backup); err != nil {
			return View{}, err
		}
		moved = true
	}

	if err := library.storage.rename(ctx, temporary, destination); err != nil {
		// A cancelled HTTP request must not prevent rollback of a local directory swap.
		if moved {
			rollback, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			defer cancel()
			if restoreErr := library.storage.rename(rollback, backup, found.directory); restoreErr != nil {
				return View{}, errors.Join(err, restoreErr)
			}
		}
		return View{}, err
	}
	if moved {
		if err := library.storage.removeStaging(rootName, backup); err != nil {
			return View{}, err
		}
	}

	snapshot, err := library.snapshot(ctx, input.Name)
	if err != nil {
		return View{}, err
	}
	return view(snapshot), nil
}

func validText(value string, maximum int) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) &&
		len(value) <= maximum && contracts.TrimText(value) != ""
}

func removeStaging(rootName, target string) error {
	if filepath.Dir(target) != rootName || !strings.HasPrefix(filepath.Base(target), ".") {
		return invalid()
	}
	if _, err := files.OrdinaryDirectory(rootName, false); err != nil {
		return err
	}
	root, err := os.OpenRoot(rootName)
	if err != nil {
		return err
	}
	defer root.Close()
	return root.RemoveAll(filepath.Base(target))
}

func (library *Library) SetEnabled(ctx context.Context, name string, enabled bool) (View, error) {
	library.mu.Lock()
	defer library.mu.Unlock()
	snapshot, err := library.snapshot(ctx, name)
	if err != nil {
		return View{}, err
	}
	if snapshot.Enabled == enabled {
		return view(snapshot), nil
	}
	root := library.enabledRoot
	if !enabled {
		root = library.disabledRoot
	}
	if _, err := files.OrdinaryDirectory(root, true); err != nil {
		return View{}, err
	}
	target := filepath.Join(root, name)
	if err := library.storage.rename(ctx, filepath.Dir(snapshot.Path), target); err != nil {
		return View{}, err
	}
	snapshot.Enabled = enabled
	snapshot.Path = filepath.Join(target, "SKILL.md")
	return view(snapshot), nil
}

func (library *Library) Remove(ctx context.Context, name string) error {
	library.mu.Lock()
	defer library.mu.Unlock()
	found, err := library.locate(ctx, name)
	if err != nil {
		return err
	}
	if found == nil {
		return missing()
	}
	tombstone := filepath.Join(filepath.Dir(found.directory), ".removed-"+uuid.NewString())
	if err := library.storage.rename(ctx, found.directory, tombstone); err != nil {
		return err
	}
	return library.storage.removeStaging(filepath.Dir(tombstone), tombstone)
}

func (library *Library) Context(ctx context.Context) (string, error) {
	items, err := library.List(ctx)
	if err != nil {
		return "", err
	}
	type reference struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Path        string `json:"path"`
	}
	references := []reference{}
	for _, item := range items {
		if item.Enabled {
			references = append(references, reference{item.Name, item.Description, item.Path})
		}
	}
	return "Available dant-managed VM skills (reference index; read SKILL.md when relevant):\n" + string(jsonBytes(references)), nil
}
