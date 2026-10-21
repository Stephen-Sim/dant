package skills

import (
	"context"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type skillReadRoot struct {
	skillRoot
	readFile      func(context.Context, string, int64) ([]byte, error)
	readDirectory func(string) ([]fs.DirEntry, error)
	closed        *int
}

func (root *skillReadRoot) Close() error {
	if root.closed != nil {
		*root.closed++
	}
	return root.skillRoot.Close()
}

func (root *skillReadRoot) ReadFile(ctx context.Context, name string, limit int64) ([]byte, error) {
	if root.readFile != nil {
		return root.readFile(ctx, name, limit)
	}
	return root.skillRoot.ReadFile(ctx, name, limit)
}

func (root *skillReadRoot) ReadDirectory(name string) ([]fs.DirEntry, error) {
	if root.readDirectory != nil {
		return root.readDirectory(name)
	}
	return root.skillRoot.ReadDirectory(name)
}

type skillDirectoryEntry struct {
	name string
	mode fs.FileMode
}

func (entry skillDirectoryEntry) Name() string               { return entry.name }
func (entry skillDirectoryEntry) IsDir() bool                { return entry.mode.IsDir() }
func (entry skillDirectoryEntry) Type() fs.FileMode          { return entry.mode }
func (entry skillDirectoryEntry) Info() (fs.FileInfo, error) { return nil, errSkillStorageFixture }

func TestSkillSnapshotRejectsInvalidTreesAndBoundedReadFailures(t *testing.T) {
	for _, scenario := range []string{"open", "manifest-read", "manifest-invalid", "directory-read", "linked-entry", "reserved-directory", "control-name", "invalid-directory", "invalid-file", "depth", "tree-count", "file-count", "support-read", "total-size", "secret", "cache"} {
		t.Run(scenario, func(t *testing.T) {
			library := makeLibrary(t)
			input := skillInput()
			if _, err := library.Save(t.Context(), input, true); err != nil {
				t.Fatal(err)
			}
			disk := library.storage
			opened := 0
			library.storage.openRoot = func(path string, create bool) (skillRoot, error) {
				opened++
				if opened == 2 && scenario == "open" {
					return nil, errSkillStorageFixture
				}
				root, err := disk.openRoot(path, create)
				if err != nil || opened != 2 {
					return root, err
				}
				return &skillReadRoot{skillRoot: root,
					readDirectory: func(directory string) ([]fs.DirEntry, error) {
						switch scenario {
						case "directory-read":
							return nil, errSkillStorageFixture
						case "linked-entry":
							return []fs.DirEntry{skillDirectoryEntry{"assets/link", fs.ModeSymlink}}, nil
						case "reserved-directory":
							return []fs.DirEntry{skillDirectoryEntry{"SKILL.md", fs.ModeDir}}, nil
						case "control-name":
							return []fs.DirEntry{skillDirectoryEntry{"assets/bad\x7f", 0}}, nil
						case "invalid-directory":
							return []fs.DirEntry{skillDirectoryEntry{"unsupported", fs.ModeDir}}, nil
						case "invalid-file":
							return []fs.DirEntry{skillDirectoryEntry{"unmanaged.txt", 0}}, nil
						case "depth":
							if directory == "." {
								return []fs.DirEntry{skillDirectoryEntry{"assets", fs.ModeDir}}, nil
							}
							return []fs.DirEntry{skillDirectoryEntry{"x", fs.ModeDir}}, nil
						case "tree-count":
							entries := make([]fs.DirEntry, TreeEntryLimit+1)
							for index := range entries {
								entries[index] = skillDirectoryEntry{"SKILL.md", 0}
							}
							return entries, nil
						case "file-count":
							entries := make([]fs.DirEntry, SupportFileLimit+1)
							for index := range entries {
								entries[index] = skillDirectoryEntry{fmt.Sprintf("assets/%03d", index), 0}
							}
							return entries, nil
						case "total-size":
							return []fs.DirEntry{skillDirectoryEntry{"assets/one", 0}, skillDirectoryEntry{"assets/two", 0}}, nil
						case "cache":
							return []fs.DirEntry{skillDirectoryEntry{"__pycache__", fs.ModeDir}}, nil
						default:
							return root.ReadDirectory(directory)
						}
					},
					readFile: func(ctx context.Context, name string, limit int64) ([]byte, error) {
						if name == "SKILL.md" {
							if scenario == "manifest-read" {
								return nil, errSkillStorageFixture
							}
							if scenario == "manifest-invalid" {
								return []byte("not a manifest"), nil
							}
							return root.ReadFile(ctx, name, limit)
						}
						switch scenario {
						case "support-read":
							return nil, errSkillStorageFixture
						case "total-size":
							return make([]byte, FileBytes), nil
						case "secret":
							return []byte("synthetic-secret-value"), nil
						case "file-count":
							return []byte{}, nil
						default:
							return root.ReadFile(ctx, name, limit)
						}
					}}, nil
			}
			result, err := library.ExportSnapshot(t.Context(), input.Name)
			if scenario == "cache" {
				if err != nil || len(result.Files) != 0 || len(result.BinaryFiles) != 0 {
					t.Fatal("ignored tool cache leaked into snapshot", err)
				}
			} else if err == nil {
				t.Fatal("invalid filesystem tree or failed read produced an export")
			}
		})
	}
}

func TestSkillMarkerListingAndInstructionValidation(t *testing.T) {
	library := makeLibrary(t)
	input := skillInput()
	if _, err := library.Save(t.Context(), input, true); err != nil {
		t.Fatal(err)
	}
	input.Name = "aaa-first"
	if _, err := library.Save(t.Context(), input, true); err != nil {
		t.Fatal(err)
	}
	items, err := library.List(t.Context())
	if err != nil || len(items) != 2 || items[0].Name != "aaa-first" {
		t.Fatal("library listing did not retain sorted skill identity", err)
	}
	marker := filepath.Join(library.enabledRoot, input.Name, markerName)
	for _, value := range []string{`{`, `{}`, `{"owner":"other","name":"aaa-first","description":"x","updatedAt":1}`} {
		if err := os.WriteFile(marker, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := library.Exists(t.Context(), input.Name); err == nil {
			t.Fatal("invalid ownership marker admitted a skill")
		}
		if items, err := library.List(t.Context()); err != nil || len(items) != 1 {
			t.Fatal("unmanaged invalid entry poisoned healthy skill listing", err)
		}
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	if _, err := library.Exists(t.Context(), input.Name); err == nil {
		t.Fatal("missing ownership marker admitted a skill")
	}
	if validMetadata(Metadata{Owner: "dant", Name: "test", UpdatedAt: math.Inf(1)}, contracts.RawObject{"description": []byte(`"x"`), "updatedAt": []byte("1")}, "test") {
		t.Fatal("nonfinite ownership timestamp accepted")
	}
	for _, value := range []string{"invalid", "---\nmissing delimiter", "---\nname: test\n---\n", "---\nname: test\n---\n\x00", "---\nname: test\n---\n" + strings.Repeat("x", InstructionBytes+1)} {
		if _, err := instructionBody([]byte(value)); err == nil {
			t.Fatal("invalid on-disk instruction body accepted")
		}
	}
	if value, err := instructionBody([]byte("\ufeff---\nname: test\n---\n\nRead this.\n")); err != nil || value != "Read this." {
		t.Fatal("instruction body lost BOM compatibility or whitespace semantics", err)
	}
}

func TestSkillListingReadsStayBoundedAndCloseTheirManagedRoots(t *testing.T) {
	for _, scenario := range []string{"read-error", "entry-limit", "vanished", "file-entry", "root-error"} {
		t.Run(scenario, func(t *testing.T) {
			library := makeLibrary(t)
			if _, err := library.Save(t.Context(), skillInput(), true); err != nil {
				t.Fatal(err)
			}
			disk := library.storage
			closed := 0
			library.storage.openRoot = func(path string, create bool) (skillRoot, error) {
				if scenario == "root-error" {
					return nil, errSkillStorageFixture
				}
				root, err := disk.openRoot(path, create)
				if err != nil {
					return nil, err
				}
				return &skillReadRoot{skillRoot: root, closed: &closed, readDirectory: func(string) ([]fs.DirEntry, error) {
					switch scenario {
					case "read-error":
						return nil, errSkillStorageFixture
					case "entry-limit":
						return make([]fs.DirEntry, TreeEntryLimit+1), nil
					case "vanished":
						return []fs.DirEntry{skillDirectoryEntry{"vanished", fs.ModeDir}}, nil
					default:
						return []fs.DirEntry{skillDirectoryEntry{"README.md", 0}, skillDirectoryEntry{"invalid!", fs.ModeDir}}, nil
					}
				}}, nil
			}
			items, err := library.List(t.Context())
			if scenario != "root-error" && closed != 1 {
				t.Fatalf("listing did not close its one managed root: %d", closed)
			}
			if scenario == "vanished" || scenario == "file-entry" {
				if err != nil || len(items) != 0 {
					t.Fatal("invalid or vanished entry was included", err)
				}
			} else if err == nil {
				t.Fatal("unreadable or oversized library was accepted")
			}
			if scenario == "root-error" {
				if _, err := library.Context(t.Context()); err == nil {
					t.Fatal("context index hid the library read failure")
				}
			}
		})
	}
}
