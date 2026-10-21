package files

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestRegularAndAnchoredReadsAcceptTheLargestRepresentableByteLimit(t *testing.T) {
	directory := t.TempDir()
	name := filepath.Join(directory, "small.txt")
	if err := os.WriteFile(name, []byte("small bounded content"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := OpenManagedRoot(directory, false)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, read := range []func() ([]byte, error){
		func() ([]byte, error) { return ReadRegular(name, math.MaxInt64) },
		func() ([]byte, error) { return root.ReadFile(t.Context(), "small.txt", math.MaxInt64) },
	} {
		if data, err := read(); err != nil || string(data) != "small bounded content" {
			t.Fatal("valid large byte limit overflowed instead of reading the small file", err)
		}
	}
}
