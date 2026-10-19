package shadow

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/transport"
)

const fixtureRevision = 7

func fixtureSnapshot(t *testing.T) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "memory-空白 #&.sqlite")
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`PRAGMA user_version = 1`,
		`CREATE TABLE memory_meta(id INTEGER PRIMARY KEY, revision INTEGER, search_revision INTEGER)`,
		`INSERT INTO memory_meta VALUES(1,7,7)`,
		`CREATE VIRTUAL TABLE memory_search USING fts5(document_key UNINDEXED,kind UNINDEXED,text,updated_at UNINDEXED,conversation_id UNINDEXED,work_id UNINDEXED)`,
		`CREATE TABLE memory_read_documents(search_rowid INTEGER PRIMARY KEY,document_key TEXT,kind TEXT,text TEXT,normalized_text TEXT,updated_at INTEGER,conversation_id TEXT,work_id TEXT,status TEXT,source_json TEXT,confidence REAL)`,
		`INSERT INTO memory_search(rowid,document_key,kind,text) VALUES(1,'identity.md','note','User prefers TypeScript. typescript')`,
		`INSERT INTO memory_read_documents(search_rowid,document_key,kind,text,normalized_text) VALUES(1,'identity.md','note','User prefers TypeScript.','user prefers typescript.')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return file
}

type response struct {
	ID     *string         `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code transport.Code `json:"code"`
	} `json:"error"`
}

type shadowSession struct {
	input  *io.PipeWriter
	frames <-chan []byte
	done   <-chan error
	cancel context.CancelFunc
}

func startShadow(t *testing.T, file string) *shadowSession {
	t.Helper()
	input, send := io.Pipe()
	output, sink := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	frames := make(chan []byte, 32)
	go func() {
		done <- Run(ctx, []string{"--role=memory-shadow", "--snapshot=" + file, "--revision=7"}, input, sink)
		sink.Close()
	}()
	go func() {
		defer close(frames)
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 1024), transport.ResponseMaxBytes+2)
		for scanner.Scan() {
			frames <- bytes.Clone(scanner.Bytes())
		}
	}()
	t.Cleanup(func() { cancel(); send.Close(); output.Close() })
	return &shadowSession{send, frames, done, cancel}
}

func (session *shadowSession) request(t *testing.T, frame string) response {
	t.Helper()
	if _, err := io.WriteString(session.input, frame+"\n"); err != nil {
		t.Fatal("could not send fixture request")
	}
	select {
	case raw, open := <-session.frames:
		if !open {
			select {
			case err := <-session.done:
				t.Fatalf("shadow ended early: %v", err)
			default:
				t.Fatal("shadow ended early")
			}
		}
		var result response
		if len(raw) > transport.ResponseMaxBytes || json.Unmarshal(raw, &result) != nil {
			t.Fatal("invalid terminal frame")
		}
		if (result.Error == nil) == (result.Result == nil) {
			t.Fatal("ambiguous terminal frame")
		}
		return result
	case <-time.After(3 * time.Second):
		t.Fatal("shadow did not respond")
	}
	return response{}
}

func fileHash(t *testing.T, file string) [sha256.Size]byte {
	t.Helper()
	value, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(value)
}

func TestShadowProcessServesPreparedSearchAndRetrievalWithoutChangingItsSnapshot(t *testing.T) {
	file := fixtureSnapshot(t)
	hash := fileHash(t, file)
	before, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	session := startShadow(t, file)
	ping := session.request(t, `{"id":"ping","method":"ping"}`)
	if ping.Error != nil || string(ping.Result) != `{"protocolVersion":1,"role":"memory-shadow","revision":7}` {
		t.Fatalf("unexpected ping: %s", ping.Result)
	}
	for _, frame := range []string{
		`{"id":"search","method":"search","params":{"query":{"terms":["typescript"]}}}`,
		`{"id":"retrieve","method":"retrieve","params":{"query":{"terms":["typescript"]},"scope":{"conversationId":"conversation"}}}`,
	} {
		result := session.request(t, frame)
		var items []map[string]json.RawMessage
		if result.Error != nil || json.Unmarshal(result.Result, &items) != nil || len(items) != 1 || string(items[0]["id"]) != `"identity.md"` || string(items[0]["kind"]) != `"note"` {
			t.Fatalf("prepared query result changed: %s", result.Result)
		}
		if _, exists := items[0]["confidence"]; exists {
			t.Fatal("note confidence must be omitted rather than invented as null")
		}
		if _, exists := items[0]["conversationId"]; exists {
			t.Fatal("global note gained a conversation identity")
		}
	}
	for _, frame := range []string{
		`{"id":"empty-search","method":"search","params":{"query":{"terms":[]}}}`,
		`{"id":"empty-retrieve","method":"retrieve","params":{"query":{"terms":[]},"scope":{"conversationId":"conversation"}}}`,
	} {
		result := session.request(t, frame)
		if result.Error != nil || string(result.Result) != "[]" {
			t.Fatal("an empty result must be an empty array")
		}
	}
	session.input.Close()
	select {
	case err := <-session.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("EOF did not stop the shadow process")
	}
	after, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if hash != fileHash(t, file) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("a read-only query modified the snapshot")
	}
	entries, err := os.ReadDir(filepath.Dir(file))
	if err != nil || len(entries) != 1 {
		t.Fatal("queries created SQLite sidecars or another file")
	}
}

func TestShadowParamsRejectNullInvalidLimitsUnknownFieldsAndUnpreparedQueries(t *testing.T) {
	file := fixtureSnapshot(t)
	session := startShadow(t, file)
	for index, params := range []string{
		`{"query":null}`,
		`{"query":{"terms":null}}`,
		`{"query":{"terms":[null]}}`,
		`{"query":{"terms":[false]}}`,
		`{"query":{"terms":["typescript"]},"limit":null}`,
		`{"query":{"terms":["typescript"]},"limit":0}`,
		`{"query":{"terms":["typescript"]},"limit":51}`,
		`{"query":{"terms":["typescript"]},"limit":1.5}`,
		`{"query":{"terms":["typescript"]},"conversationId":null}`,
		`{"query":{"terms":["typescript"]},"conversationId":""}`,
		`{"query":{"terms":["typescript"]},"extra":true}`,
		`{"query":{"terms":["typescript"],"extra":true}}`,
		`{"query":{"terms":["typescript OR *"]}}`,
	} {
		encoded, _ := json.Marshal(struct {
			ID     string          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}{"invalid-search-" + string(rune('a'+index)), "search", json.RawMessage(params)})
		result := session.request(t, string(encoded))
		if result.Error == nil || result.Error.Code != transport.InvalidParams {
			t.Fatalf("search params %d were not rejected as invalid_params", index)
		}
	}
	for index, params := range []string{
		`{"query":{"terms":[]},"scope":null}`,
		`{"query":{"terms":[]},"scope":{}}`,
		`{"query":{"terms":[]},"scope":{"conversationId":null}}`,
		`{"query":{"terms":[]},"scope":{"conversationId":"conversation","workId":null}}`,
		`{"query":{"terms":[]},"scope":{"conversationId":"conversation","workId":""}}`,
		`{"query":{"terms":[]},"scope":{"conversationId":"conversation","unexpected":true}}`,
		`{"query":{"terms":[]},"scope":{"conversationId":"conversation"},"limit":7}`,
	} {
		encoded, _ := json.Marshal(struct {
			ID     string          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}{"invalid-retrieve-" + string(rune('a'+index)), "retrieve", json.RawMessage(params)})
		result := session.request(t, string(encoded))
		if result.Error == nil || result.Error.Code != transport.InvalidParams {
			t.Fatalf("retrieve params %d were not rejected as invalid_params", index)
		}
	}
	result := session.request(t, `{"id":"surrogate","method":"retrieve","params":{"query":{"terms":[]},"scope":{"conversationId":"\ud800"}}}`)
	if result.Error == nil || result.Error.Code != transport.InvalidRequest {
		t.Fatal("an invalid identity surrogate was silently replaced")
	}
	select {
	case err := <-session.done:
		if err == nil || err.Error() != string(transport.InvalidRequest) {
			t.Fatal("an uncorrelated invalid identity did not end the session")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("an invalid identity retained its process")
	}
	validSession := startShadow(t, file)
	result = validSession.request(t, `{"id":"valid-pair","method":"retrieve","params":{"query":{"terms":[]},"scope":{"conversationId":"conv-\ud83d\ude00","workId":"literal-\\ud800"}}}`)
	if result.Error != nil || string(result.Result) != "[]" {
		t.Fatal("valid surrogate pairs or escaped literal strings were rejected")
	}
}

func TestOnlyExplicitMemoryShadowRoleAndCanonicalRevisionAreAccepted(t *testing.T) {
	for _, arguments := range [][]string{
		nil,
		{"--role=worker", "--snapshot=private.sqlite", "--revision=7"},
		{"--role=memory-shadow", "--snapshot=private.sqlite", "--revision=-1"},
		{"--role=memory-shadow", "--snapshot=private.sqlite", "--revision=01"},
		{"--role=memory-shadow", "--snapshot=private.sqlite", "--revision=9007199254740992"},
		{"--role=memory-shadow", "--snapshot=private.sqlite", "--revision=null"},
		{"--role=memory-shadow", "--snapshot=private.sqlite", "--revision=7", "--revision=7"},
		{"--role=memory-shadow", "--snapshot=private.sqlite", "--revision=7", "--port=1234"},
		{"--role=memory-shadow", "--snapshot=private.sqlite", "--revision"},
	} {
		var output bytes.Buffer
		err := Run(context.Background(), arguments, strings.NewReader(""), &output)
		if err == nil || output.Len() != 0 || strings.Contains(err.Error(), "private") {
			t.Fatal("invalid startup arguments were accepted or exposed")
		}
	}
	value, err := parseOptions([]string{"--role", "memory-shadow", "--snapshot", "private.sqlite", "--revision", "0"})
	if err != nil || value.revision != 0 || value.snapshot != "private.sqlite" {
		t.Fatal("supported split startup arguments failed")
	}
}

func TestSnapshotIsImmutableAndFailClosedWhenIdentityOrSidecarsChange(t *testing.T) {
	file := fixtureSnapshot(t)
	value, err := openSnapshot(context.Background(), file)
	if err != nil {
		t.Fatal(err)
	}
	defer value.close()
	if _, err := value.db.Exec(`UPDATE memory_meta SET revision=8`); err == nil {
		t.Fatal("the shadow database permitted a write")
	}
	if _, err := memory.NewReader(context.Background(), value.db, fixtureRevision+1); err != memory.ErrStaleSnapshot {
		t.Fatal("a stale revision was not rejected")
	}
	for _, suffix := range snapshotSidecars {
		if err := os.WriteFile(file+suffix, []byte("private sidecar"), 0600); err != nil {
			t.Fatal(err)
		}
		if value.unchanged() == nil {
			t.Fatal("an unexpected SQLite sidecar was accepted")
		}
		if err := os.Remove(file + suffix); err != nil {
			t.Fatal(err)
		}
	}
	old, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(file, old.ModTime(), old.ModTime().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if value.unchanged() == nil {
		t.Fatal("a modified snapshot retained permission to serve")
	}
}

func TestSnapshotRejectsMissingRelativeDirectoryHardLinkedOversizeAndNonProjectionFiles(t *testing.T) {
	file := fixtureSnapshot(t)
	alias := filepath.Join(filepath.Dir(file), "hardlink.sqlite")
	if err := os.Link(file, alias); err != nil {
		t.Fatal(err)
	}
	if value, err := openSnapshot(context.Background(), file); err == nil {
		value.close()
		t.Fatal("a multiply linked snapshot was accepted")
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"relative.sqlite", filepath.Dir(file), filepath.Join(filepath.Dir(file), "missing.sqlite"), ""} {
		if value, err := openSnapshot(context.Background(), invalid); err == nil {
			value.close()
			t.Fatal("an invalid snapshot path was accepted")
		}
	}
	oversize := filepath.Join(t.TempDir(), "oversize.sqlite")
	handle, err := os.Create(oversize)
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Truncate(contracts.CoreSnapshotMaxBytes + 1); err != nil {
		handle.Close()
		t.Fatal(err)
	}
	handle.Close()
	if value, err := openSnapshot(context.Background(), oversize); err == nil {
		value.close()
		t.Fatal("an oversized snapshot was accepted")
	}
	invalid := filepath.Join(t.TempDir(), "not-projection.sqlite")
	db, err := sql.Open("sqlite", invalid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE ordinary_private_data(content TEXT)`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()
	var output bytes.Buffer
	err = Run(context.Background(), []string{"--role=memory-shadow", "--snapshot=" + invalid, "--revision=7"}, strings.NewReader(""), &output)
	if err == nil || err.Error() != string(transport.InvalidSnapshot) || output.Len() != 0 {
		t.Fatal("a non-projection database was allowed to serve")
	}
}
