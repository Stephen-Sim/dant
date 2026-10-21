package voice

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestTranscriptionFixtureProcess(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "--isolated-audio-fixture" {
		return
	}
	switch os.Args[len(os.Args)-1] {
	case "success":
		_, _ = fmt.Fprint(os.Stdout, "{\"text\":\"fixture transcription\"}")
		_, _ = fmt.Fprint(os.Stderr, "fixture diagnostic")
	case "overflow":
		_, _ = fmt.Fprint(os.Stdout, strings.Repeat("x", transcriptionOutputBytes+1))
	case "wait":
		_, _ = fmt.Fprint(os.Stdout, "fixture ready")
		for {
			time.Sleep(time.Hour)
		}
	default:
		os.Exit(7)
	}
	os.Exit(0)
}

func TestTranscriptionProcessCollectsBoundedOutputAndJoinsOwnedChild(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"success", "overflow", "failure", "wait"} {
		t.Run(mode, func(t *testing.T) {
			process, err := spawnTranscription(TranscriptionCommand{Program: executable, Args: []string{"-test.run=^TestTranscriptionFixtureProcess$", "--", "--isolated-audio-fixture", mode}})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = process.Kill() })
			if mode == "wait" {
				// Windows does not implement SIGTERM. Either classified signal
				// outcome is followed by killing and joining this owned child.
				_ = process.Terminate()
				_ = process.Kill()
			}
			var result TranscriptionProcessResult
			select {
			case result = <-process.Done():
			case <-time.After(callLifecycleIOTimeout):
				t.Fatal("owned transcription process did not finish")
			}
			switch mode {
			case "success":
				if result.ExitCode != 0 || result.Error != nil || string(result.Output) != `{"text":"fixture transcription"}` || string(result.Stderr) != "fixture diagnostic" || result.Overflow {
					t.Fatal("successful process lost bounded result")
				}
			case "overflow":
				if !result.Overflow || len(result.Output) != 0 {
					t.Fatal("oversized process output was retained")
				}
				select {
				case <-process.Overflow():
				default:
					t.Fatal("overflow did not notify its owner")
				}
			case "failure", "wait":
				if result.Error == nil || result.ExitCode == 0 {
					t.Fatal("failed or stopped process reported success")
				}
			}
			if _, open := <-process.Done(); open {
				t.Fatal("process completion channel remained open")
			}
		})
	}
	if _, err := spawnTranscription(TranscriptionCommand{Program: "missing-isolated-fixture-executable"}); err == nil {
		t.Fatal("nonexistent executable was started")
	}
}

func TestAudioOutputDropsAllBytesAfterItsFirstOverflow(t *testing.T) {
	notified := 0
	output := &audioOutput{limit: 3, notify: func() { notified++ }}
	for _, data := range [][]byte{[]byte("ab"), []byte("cd"), []byte("ef")} {
		if n, err := output.Write(data); n != len(data) || err != nil {
			t.Fatal("bounded writer changed pipe progress", n, err)
		}
	}
	if notified != 1 || !output.overflowed || output.data.Len() != 0 {
		t.Fatal("overflow was repeated or retained partial content")
	}
	withoutCallback := &audioOutput{data: *bytes.NewBufferString("full"), limit: 4}
	_, _ = withoutCallback.Write([]byte("overflow"))
	if !withoutCallback.overflowed || withoutCallback.data.Len() != 0 {
		t.Fatal("writer without observer retained oversized content")
	}
}
