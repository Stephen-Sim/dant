package computer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestManagedVMwareReferencesRequireCanonicalLocationAndExactOrdinaryFile(t *testing.T) {
	directory := t.TempDir()
	owned := filepath.Join(directory, "dant.vmdk")
	if err := os.WriteFile(owned, []byte("isolated owned disk"), 0600); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(owned)
	if err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(directory, "foreign.vmdk")
	if err := os.WriteFile(foreign, []byte("isolated owned disk"), 0600); err != nil {
		t.Fatal(err)
	}
	hardlink := filepath.Join(directory, "foreign-hardlink.vmdk")
	if err := os.Link(owned, hardlink); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name      string
		reference string
		expected  string
		accepted  bool
	}{
		{"same location", owned, owned, true},
		{"canonical alias", owned, canonical, true},
		{"foreign file with equal content", foreign, owned, false},
		{"foreign hardlink to same inode", hardlink, owned, false},
		{"missing reference", filepath.Join(directory, "missing.vmdk"), owned, false},
		{"missing expected", owned, filepath.Join(directory, "missing.vmdk"), false},
		{"directory reference", directory, owned, false},
		{"directory expected", owned, directory, false},
		{"relative reference", "dant.vmdk", owned, false},
		{"relative expected", owned, "dant.vmdk", false},
		{"missing ancestor", filepath.Join(directory, "missing", "dant.vmdk"), owned, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if accepted := sameManagedVMwareFile(test.reference, test.expected); accepted != test.accepted {
				t.Fatal("managed reference accepted a different file or rejected its canonical identity")
			}
		})
	}
	if data, err := os.ReadFile(owned); err != nil || string(data) != "isolated owned disk" {
		t.Fatal("identity validation modified the owned file", err)
	}
}
