package backups

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

type transformMemoryReport struct {
	HeapSystemBytes   uint64 `json:"heapSystemBytes"`
	PeakResidentBytes uint64 `json:"peakResidentBytes"`
}

func TestMain(tests *testing.M) {
	if os.Getenv("DANT_BACKUP_TRANSFORM_FIXTURE_CHILD") == "1" {
		if RunTransform(context.Background(), os.Stdin, os.Stdout) != nil {
			os.Exit(1)
		}
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		_ = json.NewEncoder(os.Stderr).Encode(transformMemoryReport{memory.HeapSys, fixturePeakResidentBytes()})
		os.Exit(0)
	}
	os.Exit(tests.Run())
}

func TestLargeBackupTransformUsesPrivateMappedChildWithBoundedHeap(t *testing.T) {
	const size = int64(256 * 1024 * 1024)
	directory := t.TempDir()
	name, _ := stageName(directory, NewID())
	file, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}

	if err := file.Truncate(size + gcmTagBytes); err != nil {
		file.Close()
		t.Fatal(err)
	}

	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	key := bytes.Repeat([]byte{1}, gcmKeyBytes)
	nonce := bytes.Repeat([]byte{2}, gcmNonceBytes)
	for _, mode := range []string{"encrypt", "decrypt"} {
		request, _ := json.Marshal(TransformRequest{Directory: directory, File: name, Mode: mode, Bytes: size, Key: key, Nonce: nonce, AAD: []byte("isolated memory fixture")})
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		command := exec.CommandContext(ctx, os.Args[0], "-test.run=^$")
		command.Env = append(os.Environ(), "DANT_BACKUP_TRANSFORM_FIXTURE_CHILD=1")
		command.Stdin = bytes.NewReader(request)
		var output, statistics bytes.Buffer
		command.Stdout = &output
		command.Stderr = &statistics
		err := command.Run()
		cancel()
		if err != nil {
			t.Fatal("isolated transform process failed")
		}
		var receipt TransformReceipt
		var report transformMemoryReport
		if output.Len() > 256 || statistics.Len() > 1024 || json.Unmarshal(output.Bytes(), &receipt) != nil || !receipt.OK || json.Unmarshal(statistics.Bytes(), &report) != nil {
			t.Fatal("invalid transform receipt or memory statistics")
		}
		if report.HeapSystemBytes > 64*1024*1024 {
			t.Fatal("transform allocated an archive-sized Go heap")
		}
		if report.PeakResidentBytes == 0 || report.PeakResidentBytes > uint64(size)+160*1024*1024 {
			t.Fatal("transform resident memory exceeded the mapped file and fixed runtime budget")
		}
		t.Logf("%s fixtureMiB=%d childHeapMiB=%d childPeakResidentMiB=%d", mode, size/(1024*1024), report.HeapSystemBytes/(1024*1024), report.PeakResidentBytes/(1024*1024))
	}
	file, err = os.Open(filepath.Clean(name))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	buffer := make([]byte, ChunkBytes)
	var total int64
	for {
		count, err := file.Read(buffer)
		for _, value := range buffer[:count] {
			if value != 0 {
				t.Fatal("large fixture plaintext changed")
			}
		}
		total += int64(count)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}

	if total != size {
		t.Fatal("large fixture length changed")
	}
}
