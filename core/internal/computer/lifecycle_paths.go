package computer

import (
	"os"
	"path/filepath"

	"github.com/Stephen-Sim/dant/core/internal/files"
)

// Windows may spell the same ordinary path with a short DOS name. Resolve
// aliases only after rejecting linked ancestors, and require both the canonical
// location and filesystem identity. A hard link at another location is not an
// owned reference to the fixed VMware file.
func sameManagedVMwareFile(reference, expected string) bool {
	if !filepath.IsAbs(reference) || !filepath.IsAbs(expected) {
		return false
	}
	for _, name := range []string{reference, expected} {
		if _, err := files.OrdinaryDirectory(filepath.Dir(name), false); err != nil {
			return false
		}
	}

	referenced, err := os.Lstat(reference)
	if err != nil || !referenced.Mode().IsRegular() {
		return false
	}
	owned, err := os.Lstat(expected)
	if err != nil || !owned.Mode().IsRegular() || !os.SameFile(referenced, owned) {
		return false
	}

	canonicalReference, err := filepath.EvalSymlinks(reference)
	if err != nil {
		return false
	}
	canonicalExpected, err := filepath.EvalSymlinks(expected)
	return err == nil && canonicalReference == canonicalExpected
}
