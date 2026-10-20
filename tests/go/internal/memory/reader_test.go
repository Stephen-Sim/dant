package memory

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	_ "modernc.org/sqlite"
)

const fixtureSchema = `PRAGMA journal_mode=DELETE; PRAGMA user_version=1;
CREATE TABLE memory_meta(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, search_revision INTEGER NOT NULL);
INSERT INTO memory_meta VALUES(1,7,7);
CREATE VIRTUAL TABLE memory_search USING fts5(document_key UNINDEXED,kind UNINDEXED,text,updated_at UNINDEXED,conversation_id UNINDEXED,work_id UNINDEXED);
CREATE TABLE memory_read_documents(search_rowid INTEGER PRIMARY KEY,document_key TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,normalized_text TEXT NOT NULL,updated_at INTEGER,conversation_id TEXT,work_id TEXT,status TEXT,source_json TEXT,confidence REAL);`

type fixture struct {
	writer *sql.DB
	db     *sql.DB
	reader *Reader
	file   string
}

func ptr[T any](value T) *T { return &value }

func newFixture(t testing.TB) *fixture {
	t.Helper()
	file := filepath.Join(t.TempDir(), "snapshot.sqlite")
	writer, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	writer.SetMaxOpenConns(1)
	t.Cleanup(func() { writer.Close() })
	if _, err := writer.Exec(fixtureSchema); err != nil {
		t.Fatal(err)
	}
	uriPath := filepath.ToSlash(file)
	if filepath.VolumeName(file) != "" {
		uriPath = "/" + uriPath
	}
	uri := url.URL{Scheme: "file", Path: uriPath}
	query := url.Values{"mode": {"ro"}, "_pragma": {"query_only(1)", "trusted_schema(OFF)", "busy_timeout(5000)"}}
	uri.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(4)
	t.Cleanup(func() { db.Close() })
	reader, err := NewReader(context.Background(), db, 7)
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{writer: writer, db: db, reader: reader, file: file}
}

type fixtureDocument struct {
	id, kind, text string
	indexed        string
	conversation   *string
	work           *string
	status         *string
	updated        *int64
	source         *Source
	confidence     *float64
}

func (f *fixture) add(t testing.TB, doc fixtureDocument) {
	t.Helper()
	if doc.kind == "" {
		doc.kind = "semantic"
	}
	if doc.kind == "semantic" || doc.kind == "episodic" {
		if doc.status == nil {
			doc.status = ptr("confirmed")
		}
		if doc.source == nil {
			doc.source = &Source{Kind: "user", ConversationID: doc.conversation, WorkID: doc.work}
		}
	}
	if doc.kind != "note" && doc.updated == nil {
		doc.updated = ptr(int64(1000))
	}
	indexed := doc.indexed
	if indexed == "" {
		indexed = doc.text + "\n" + strings.ToLower(doc.text)
	}
	inserted, err := f.writer.Exec("INSERT INTO memory_search(document_key,kind,text,updated_at,conversation_id,work_id) VALUES(?,?,?,?,?,?)", doc.id, doc.kind, indexed, doc.updated, doc.conversation, doc.work)
	if err != nil {
		t.Fatal(err)
	}
	rowID, err := inserted.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	var source *string
	if doc.source != nil {
		encoded, err := json.Marshal(doc.source)
		if err != nil {
			t.Fatal(err)
		}
		source = ptr(string(encoded))
	}
	_, err = f.writer.Exec("INSERT INTO memory_read_documents VALUES(?,?,?,?,?,?,?,?,?,?,?)", rowID, doc.id, doc.kind, doc.text, strings.ToLower(doc.text), doc.updated, doc.conversation, doc.work, doc.status, source, doc.confidence)
	if err != nil {
		t.Fatal(err)
	}
}

func ids(results []Reference) []string {
	values := make([]string, len(results))
	for index, result := range results {
		values[index] = result.ID
	}
	slices.Sort(values)
	return values
}

func TestRealFTSSearchAndRetrievalContracts(t *testing.T) {
	f := newFixture(t)
	f.add(t, fixtureDocument{id: "both", text: "Python renderer"})
	f.add(t, fixtureDocument{id: "one", text: "Python other"})
	query := PreparedQuery{Terms: []string{"python", "renderer"}}
	search, err := f.reader.Search(context.Background(), query, SearchOptions{Limit: 10})
	if err != nil || len(search) != 1 || search[0].ID != "both" || search[0].Score <= 0 {
		t.Fatalf("strict FTS AND contract: %v, %v", search, err)
	}
	recalled, err := f.reader.Retrieve(context.Background(), query, Scope{ConversationID: "conversation"}, RetrieveOptions{Limit: 6})
	if err != nil || !slices.Equal(ids(recalled), []string{"both", "one"}) {
		t.Fatalf("recall OR contract: %v, %v", ids(recalled), err)
	}
	f.add(t, fixtureDocument{id: "old", text: "lattice", updated: ptr(int64(1000))})
	f.add(t, fixtureDocument{id: "new", text: "lattice", updated: ptr(int64(2000))})
	search, err = f.reader.Search(context.Background(), PreparedQuery{Terms: []string{"lattice"}}, SearchOptions{Limit: 2})
	if err != nil || len(search) != 2 || search[0].ID != "new" {
		t.Fatalf("equal-rank search uses timestamp: %v", err)
	}
}

func TestRetrievalScopeFiltersBeforeLimit(t *testing.T) {
	f := newFixture(t)
	for _, doc := range []fixtureDocument{
		{id: "global", text: "Python preference"},
		{id: "conversation", text: "Python fact", conversation: ptr("conv-a")},
		{id: "scoped", text: "Python work fact", conversation: ptr("conv-a"), work: ptr("work-a")},
		{id: "episode", kind: "episodic", text: "Python episode", conversation: ptr("conv-a")},
		{id: "unscoped-episode", kind: "episodic", text: "Python outside episode"},
		{id: "orphan", text: "Python orphan", work: ptr("work-a")},
		{id: "work-a", kind: "project", text: "Python project", conversation: ptr("conv-a"), work: ptr("work-a")},
		{id: "README.md", kind: "note", text: "Python reference"},
	} {
		f.add(t, doc)
	}
	query := PreparedQuery{Terms: []string{"python"}}
	plain, err := f.reader.Retrieve(context.Background(), query, Scope{ConversationID: "conv-a"}, RetrieveOptions{Limit: 6})
	if err != nil || !slices.Equal(ids(plain), []string{"conversation", "episode", "global"}) {
		t.Fatalf("conversation-only scope: %v, %v", ids(plain), err)
	}
	results, err := f.reader.Retrieve(context.Background(), query, Scope{ConversationID: "conv-a", WorkID: ptr("work-a")}, RetrieveOptions{Limit: 6})
	if err != nil || !slices.Equal(ids(results), []string{"conversation", "episode", "global", "scoped", "work-a"}) {
		t.Fatalf("exact work scope: %v, %v", ids(results), err)
	}
	for index := 0; index < 20; index++ {
		f.add(t, fixtureDocument{id: fmt.Sprintf("outsider-%d", index), kind: "project", text: "renderer", conversation: ptr("conv-b"), work: ptr(fmt.Sprintf("outsider-%d", index))})
	}
	f.add(t, fixtureDocument{id: "wanted", kind: "project", text: "A longer verified renderer result", conversation: ptr("conv-a"), work: ptr("wanted")})
	results, err = f.reader.Retrieve(context.Background(), PreparedQuery{Terms: []string{"renderer"}}, Scope{ConversationID: "conv-a", WorkID: ptr("wanted")}, RetrieveOptions{Limit: 1})
	if err != nil || len(results) != 1 || results[0].ID != "wanted" {
		t.Fatalf("scope must precede rank/limit: %v, %v", ids(results), err)
	}
}

func TestSnapshotConfirmationAndAuthoritativeContent(t *testing.T) {
	f := newFixture(t)
	for _, status := range []string{"candidate", "conflicted", "rejected", "confirmed"} {
		f.add(t, fixtureDocument{id: status, text: "Bamboo preference", status: ptr(status)})
	}
	results, err := f.reader.Retrieve(context.Background(), PreparedQuery{Terms: []string{"bamboo"}}, Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6})
	if err != nil || !slices.Equal(ids(results), []string{"confirmed"}) {
		t.Fatalf("confirmation status: %v, %v", ids(results), err)
	}
	f.add(t, fixtureDocument{id: "working-memory.md", kind: "note", text: "Actual Python renderer", indexed: "indexonlykeyword\nindexonlykeyword"})
	results, err = f.reader.Retrieve(context.Background(), PreparedQuery{Terms: []string{"indexonlykeyword"}}, Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6})
	if err != nil || len(results) != 0 {
		t.Fatal("FTS-only content must not become an authoritative excerpt", err)
	}
	if _, err := f.writer.Exec("UPDATE memory_read_documents SET status='unrecognized' WHERE document_key='confirmed'"); err != nil {
		t.Fatal(err)
	}
	_, err = f.reader.Retrieve(context.Background(), PreparedQuery{Terms: []string{"bamboo"}}, Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6})
	if !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("unknown confirmation cannot become confirmed", err)
	}
}

func TestSnapshotReadOnlyRevisionAndErrorBoundaries(t *testing.T) {
	f := newFixture(t)
	f.add(t, fixtureDocument{id: "fact", text: "Python"})
	before, err := os.ReadFile(f.file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.reader.Search(context.Background(), PreparedQuery{Terms: []string{"python"}}, SearchOptions{Limit: 10}); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(f.file)
	if err != nil || sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("query changed the immutable snapshot")
	}
	if _, err := f.db.Exec("DELETE FROM memory_meta"); err == nil {
		t.Fatal("fixture must genuinely use a read-only database")
	}
	if _, err := f.writer.Exec("UPDATE memory_meta SET revision=8"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reader.Search(context.Background(), PreparedQuery{}, SearchOptions{Limit: 10}); !errors.Is(err, ErrStaleSnapshot) {
		t.Fatal("empty query must not conceal stale index", err)
	}
	if _, err := NewReader(context.Background(), f.db, 8); !errors.Is(err, ErrStaleSnapshot) {
		t.Fatal("new reader must not rebuild a stale FTS index", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.reader.Search(ctx, PreparedQuery{}, SearchOptions{Limit: 10}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	f.db.Close()
	if _, err := f.reader.Search(context.Background(), PreparedQuery{Terms: []string{"fixtureprivatevalue"}}, SearchOptions{Limit: 10}); !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "fixtureprivatevalue") {
		t.Fatal("operational errors must stay bounded", err)
	}
}

func TestCJKUTF16ExcerptsAndNullableConfidence(t *testing.T) {
	f := newFixture(t)
	f.add(t, fixtureDocument{id: "cjk", text: "长期记忆采用关键词检索", indexed: "长期记忆采用关键词检索\n长期 期记 记忆 忆采 采用"})
	results, err := f.reader.Retrieve(context.Background(), PreparedQuery{Terms: []string{"长期", "记忆"}}, Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6})
	if err != nil || len(results) != 1 || results[0].ID != "cjk" {
		t.Fatal("actual FTS5 CJK expansion recall failed", err)
	}
	encoded, err := json.Marshal(results[0])
	if err != nil || !strings.Contains(string(encoded), `"confidence":null`) || !strings.Contains(string(encoded), `"source":{"kind":"user"}`) {
		t.Fatalf("nullable source confidence changed: %s %v", encoded, err)
	}
	f.add(t, fixtureDocument{id: "boundary", text: strings.Repeat("x", 511) + "😀 python"})
	search, err := f.reader.Search(context.Background(), PreparedQuery{Terms: []string{"python"}}, SearchOptions{Limit: 10})
	if err != nil || len(search) != 1 || search[0].Text.UTF16Length() != 512 {
		t.Fatal("search excerpt must count UTF-16 code units", err)
	}
	encoded, err = json.Marshal(search[0].Text)
	if err != nil || !strings.HasSuffix(string(encoded), `\ud83d"`) {
		t.Fatalf("must preserve JavaScript's cut surrogate boundary: %s", encoded)
	}
	f.add(t, fixtureDocument{id: "identity.md", kind: "note", text: "Intro. " + strings.Repeat("ordinary words. ", 220) + "Cairo rendering reference"})
	for index := 0; index < 8; index++ {
		f.add(t, fixtureDocument{id: fmt.Sprintf("long-%d", index), text: "Cairo " + strings.Repeat("😀 repeated reference. ", 100)})
	}
	results, err = f.reader.Retrieve(context.Background(), PreparedQuery{Terms: []string{"cairo"}}, Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6})
	if err != nil || len(results) > 6 {
		t.Fatal(err)
	}
	total := 0
	for _, result := range results {
		total += result.Text.UTF16Length()
		if result.Text.UTF16Length() > ExcerptUnits {
			t.Fatal("excerpt exceeded its UTF-16 budget")
		}
	}
	if total > RetrievalBudgetUnits {
		t.Fatal("combined recall text exceeded its budget")
	}
	if excerpt, matched := relevantExcerpt("introduction "+strings.Repeat("abc ", 500)+"Cairo renderer", "introduction "+strings.Repeat("abc ", 500)+"cairo renderer", []string{"cairo"}, 512); !matched || excerpt.units[0] != '…' {
		t.Fatal("deep recall must select a relevant excerpt")
	}
}

func TestPreparedInputsAndSourceScopeStayStrict(t *testing.T) {
	f := newFixture(t)
	for _, query := range []PreparedQuery{{Terms: []string{"python OR renderer"}}, {Terms: []string{"python", "python"}}, {Terms: []string{strings.Repeat("a", MaxSearchPreparedUnits+1)}}, {Terms: []string{"\x00"}}, {Terms: slices.Repeat([]string{"x"}, 17)}} {
		if _, err := f.reader.Search(context.Background(), query, SearchOptions{Limit: 10}); !errors.Is(err, ErrInvalidQuery) {
			t.Fatal(err)
		}
	}
	for _, scope := range []Scope{{}, {ConversationID: "wrong scope"}, {ConversationID: "conv", WorkID: ptr("")}, {ConversationID: strings.Repeat("😀", 129)}} {
		if _, err := f.reader.Retrieve(context.Background(), PreparedQuery{}, scope, RetrieveOptions{Limit: 6}); !errors.Is(err, ErrInvalidScope) {
			t.Fatal(err)
		}
	}
	for _, limit := range []int{0, -1, 51} {
		if _, err := f.reader.Search(context.Background(), PreparedQuery{}, SearchOptions{Limit: limit}); !errors.Is(err, ErrInvalidLimit) {
			t.Fatal(err)
		}
	}
	f.add(t, fixtureDocument{id: "fact", text: "Python"})
	for _, source := range []string{`{"kind":"user","workId":null}`, `{"kind":"user","workId":"different"}`, `{"kind":"user","extra":"fixtureprivatevalue"}`, `{"kind":"unrecognized"}`} {
		if _, err := f.writer.Exec("UPDATE memory_read_documents SET source_json=?", source); err != nil {
			t.Fatal(err)
		}
		_, err := f.reader.Retrieve(context.Background(), PreparedQuery{Terms: []string{"python"}}, Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6})
		if !errors.Is(err, ErrInvalidSnapshot) || strings.Contains(err.Error(), "fixtureprivatevalue") {
			t.Fatal("malformed source must not broaden scope or leak", err)
		}
	}
}

func TestSearchNFKCExpansionRetainsTheOriginalUTF16Contract(t *testing.T) {
	f := newFixture(t)
	original, expanded := strings.Repeat("ﬃ", 256), strings.Repeat("ffi", 256)
	f.add(t, fixtureDocument{id: "ligature", text: original, indexed: original + "\n" + expanded})
	results, err := f.reader.Search(context.Background(), PreparedQuery{Terms: []string{expanded}}, SearchOptions{Limit: 10})
	if err != nil || len(results) != 1 || results[0].ID != "ligature" || results[0].Text.UTF16Length() != 256 {
		t.Fatal("NFKC expansion must not reapply the pre-normalization search limit", err)
	}
	if _, err := f.reader.Retrieve(context.Background(), PreparedQuery{Terms: []string{expanded}}, Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6}); !errors.Is(err, ErrInvalidQuery) {
		t.Fatal("retrieval still bounds the combined prepared terms", err)
	}
}

func TestNodeNumberFTSTimestampsMatchIntegerAuthorityWithoutCoercion(t *testing.T) {
	f := newFixture(t)
	query := PreparedQuery{Terms: []string{"cobalt"}}
	for _, timestamp := range []int64{1, 1760000000000, maxTimestamp} {
		id := fmt.Sprintf("time-%d", timestamp)
		f.add(t, fixtureDocument{id: id, text: "cobalt", updated: ptr(timestamp)})
	}
	// This is the SQLite storage shape produced by DatabaseSync.run(JS number):
	// REAL in FTS UNINDEXED columns, INTEGER in the authority's affinity column.
	if _, err := f.writer.Exec("UPDATE memory_search SET updated_at=CAST(updated_at AS REAL)"); err != nil {
		t.Fatal(err)
	}
	var indexedType, authorityType string
	if err := f.writer.QueryRow("SELECT typeof(s.updated_at),typeof(a.updated_at) FROM memory_search s JOIN memory_read_documents a ON a.search_rowid=s.rowid LIMIT 1").Scan(&indexedType, &authorityType); err != nil || indexedType != "real" || authorityType != "integer" {
		t.Fatal("fixture did not preserve the cross-runtime SQLite number types", err)
	}
	results, err := f.reader.Search(context.Background(), query, SearchOptions{Limit: 10})
	if err != nil || len(results) != 3 || results[0].UpdatedAt == nil || *results[0].UpdatedAt != maxTimestamp {
		t.Fatal("REAL FTS timestamps must match their exact INTEGER authority", err)
	}
	recalled, err := f.reader.Retrieve(context.Background(), query, Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6})
	if err != nil || len(recalled) != 3 {
		t.Fatal("automatic retrieval must accept the same exact numeric timestamps", err)
	}
	for _, invalid := range []struct {
		name  string
		value any
	}{
		{"zero", int64(0)}, {"negative", int64(-1)}, {"fraction", 1000.5},
		{"above-date-range", float64(maxTimestamp + 1)}, {"unsafe-integer", float64(maxSafeInteger) + 1},
		{"infinity", math.Inf(1)}, {"numeric-text", "1000"}, {"numeric-bytes", []byte("1000")},
	} {
		t.Run(invalid.name, func(t *testing.T) {
			if _, err := f.writer.Exec("UPDATE memory_search SET updated_at=?", invalid.value); err != nil {
				t.Fatal(err)
			}
			if _, err := f.reader.Search(context.Background(), query, SearchOptions{Limit: 10}); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatal("invalid timestamp must not be coerced or returned", err)
			}
		})
	}
}

func TestConcurrentRequestsReuseTheReadOnlyPool(t *testing.T) {
	f := newFixture(t)
	f.add(t, fixtureDocument{id: "shared", text: "Python renderer", conversation: ptr("conv")})
	var group sync.WaitGroup
	failures := make(chan error, 24)
	for index := 0; index < 24; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			results, err := f.reader.Retrieve(context.Background(), PreparedQuery{Terms: []string{"python"}}, Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6})
			if err == nil && (len(results) != 1 || results[0].ID != "shared") {
				err = errors.New("isolated concurrent result mismatch")
			}
			failures <- err
		}()
	}
	group.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	if f.db.Stats().OpenConnections > 4 {
		t.Fatal("query unexpectedly expanded the caller-owned pool")
	}
}

func TestMalformedSnapshotCannotLookLikeAnEmptySuccessfulSearch(t *testing.T) {
	f := newFixture(t)
	if _, err := NewReader(context.Background(), nil, 7); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal(err)
	}
	if _, err := NewReader(context.Background(), f.db, -1); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal(err)
	}
	if _, err := f.writer.Exec("PRAGMA user_version=2"); err != nil {
		t.Fatal(err)
	}
	if _, err := NewReader(context.Background(), f.db, 7); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal(err)
	}
	if _, err := f.writer.Exec("PRAGMA user_version=1; ALTER TABLE memory_read_documents ADD COLUMN unexpected TEXT"); err != nil {
		t.Fatal(err)
	}
	if _, err := NewReader(context.Background(), f.db, 7); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal(err)
	}
}

func BenchmarkMemoryRetrieve(b *testing.B) {
	f := newFixture(b)
	if _, err := f.writer.Exec("BEGIN IMMEDIATE"); err != nil {
		b.Fatal(err)
	}
	for index := 0; index < 1000; index++ {
		f.add(b, fixtureDocument{id: fmt.Sprintf("fact-%04d", index), text: "Python renderer uses Cairo. " + strings.Repeat("reference text ", 12), conversation: ptr(fmt.Sprintf("conv-%d", index%16))})
	}
	if _, err := f.writer.Exec("COMMIT"); err != nil {
		b.Fatal(err)
	}
	query, scope := PreparedQuery{Terms: []string{"python", "renderer"}}, Scope{ConversationID: "conv-0"}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := f.reader.Retrieve(context.Background(), query, scope, RetrieveOptions{Limit: 6}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkMemorySearch(b *testing.B) {
	f := newFixture(b)
	if _, err := f.writer.Exec("BEGIN IMMEDIATE"); err != nil {
		b.Fatal(err)
	}
	for index := 0; index < 1000; index++ {
		f.add(b, fixtureDocument{id: fmt.Sprintf("fact-%04d", index), text: "Python renderer uses Cairo."})
	}
	if _, err := f.writer.Exec("COMMIT"); err != nil {
		b.Fatal(err)
	}
	query := PreparedQuery{Terms: []string{"python", "renderer"}}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if _, err := f.reader.Search(context.Background(), query, SearchOptions{Limit: 10}); err != nil {
			b.Fatal(err)
		}
	}
}
