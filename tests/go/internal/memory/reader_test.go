package memory

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type fixture struct {
	writer *sql.DB
	store  *Store
	reader *fixtureReader
	nextID string
	now    int64
}

func ptr[T any](value T) *T { return &value }

func newFixture(t testing.TB) *fixture {
	t.Helper()
	f := &fixture{now: 1000}
	store, err := OpenStore(context.Background(), t.TempDir(), StoreOptions{
		Now:   func() time.Time { return time.UnixMilli(f.now) },
		NewID: func() string { return f.nextID },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	writer, err := sql.Open("sqlite", store.DatabaseFile())
	if err != nil {
		t.Fatal(err)
	}
	writer.SetMaxOpenConns(1)
	t.Cleanup(func() { writer.Close() })
	f.store, f.writer, f.reader = store, writer, &fixtureReader{store: store}
	return f
}

// Exercise prepared query validation inside the same locked Store transaction
// used by public Search and Retrieve, without a second database representation.
type fixtureReader struct{ store *Store }

func (f *fixtureReader) Search(ctx context.Context, query PreparedQuery, options SearchOptions) ([]SearchResult, error) {
	f.store.mu.Lock()
	defer f.store.mu.Unlock()
	var result []SearchResult
	err := f.store.withReader(ctx, func(reader *queryReader) error {
		var err error
		result, err = reader.Search(ctx, query, options)
		return err
	})
	return result, err
}

func (f *fixtureReader) Retrieve(ctx context.Context, query PreparedQuery, scope Scope, options RetrieveOptions) ([]Reference, error) {
	f.store.mu.Lock()
	defer f.store.mu.Unlock()
	var result []Reference
	err := f.store.withReader(ctx, func(reader *queryReader) error {
		var err error
		result, err = reader.Retrieve(ctx, query, scope, options)
		return err
	})
	return result, err
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
	ctx := context.Background()
	if doc.kind == "" {
		doc.kind = "semantic"
	}
	f.nextID, f.now = doc.id, 1000
	if doc.updated != nil {
		f.now = *doc.updated
	}
	switch doc.kind {
	case "note":
		if err := f.store.WriteNote(ctx, doc.id, doc.text); err != nil {
			t.Fatal(err)
		}
	case "project":
		if doc.conversation == nil || doc.work == nil {
			t.Fatal("project fixture requires exact conversation and work")
		}
		project, err := json.Marshal(ProjectContext{Version: 1, UpdatedAt: f.now, OriginalRequest: &ProjectEntry{MessageID: "request", At: f.now, Text: doc.text, Attachments: []ProjectAttachment{}}, HumanUpdates: []ProjectEntry{}, Results: []ProjectEntry{}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.store.WriteProject(ctx, *doc.conversation, *doc.work, project); err != nil {
			t.Fatal(err)
		}
	case "semantic", "episodic":
		if doc.source == nil {
			doc.source = &Source{Kind: "user", ConversationID: doc.conversation, WorkID: doc.work}
		}
		entry, err := f.store.Propose(ctx, Proposal{Kind: doc.kind, Text: doc.text, Key: &doc.id, Source: *doc.source, Confidence: doc.confidence})
		if err != nil || entry.ID != doc.id {
			t.Fatal("fixture write did not retain its assigned identity", err)
		}
		if doc.status == nil || *doc.status == string(contracts.MemoryEntryStatusConfirmed) {
			if _, err := f.store.Confirm(ctx, entry.ID, false); err != nil {
				t.Fatal(err)
			}
		} else if *doc.status != string(contracts.MemoryEntryStatusCandidate) {
			if _, err := f.writer.Exec("UPDATE memory_entries SET status=? WHERE id=?", *doc.status, doc.id); err != nil {
				t.Fatal(err)
			}
		}
	default:
		t.Fatal("unknown fixture kind")
	}
	if _, err := f.store.Search(ctx, "", SearchOptions{Limit: 10}); err != nil {
		t.Fatal(err)
	}
	if doc.indexed != "" {
		if _, err := f.writer.Exec("UPDATE memory_search SET text=? WHERE document_key=?", doc.indexed, doc.id); err != nil {
			t.Fatal(err)
		}
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

func TestConfirmationAndAuthoritativeContent(t *testing.T) {
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
	if _, err := f.writer.Exec("UPDATE memory_entries SET status='unrecognized' WHERE id='confirmed'"); err == nil {
		t.Fatal("schema admitted an unknown confirmation state")
	}
	// Simulate pre-existing disk corruption on this fixture-only connection.
	// Production reads open a new connection with all schema checks enabled.
	if _, err := f.writer.Exec("PRAGMA ignore_check_constraints=ON; UPDATE memory_entries SET status='unrecognized' WHERE id='confirmed'; UPDATE memory_meta SET search_revision=revision; PRAGMA ignore_check_constraints=OFF"); err != nil {
		t.Fatal(err)
	}
	_, err = f.reader.Retrieve(context.Background(), PreparedQuery{Terms: []string{"bamboo"}}, Scope{ConversationID: "conv"}, RetrieveOptions{Limit: 6})
	if !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatal("unknown confirmation cannot become confirmed", err)
	}
}

func TestStoreRefreshesStaleIndexWithoutChangingAuthorityAndKeepsErrorsBounded(t *testing.T) {
	f := newFixture(t)
	f.add(t, fixtureDocument{id: "fact", text: "Python"})
	var before, after string
	if err := f.writer.QueryRow("SELECT text FROM memory_entries WHERE id='fact'").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reader.Search(context.Background(), PreparedQuery{Terms: []string{"python"}}, SearchOptions{Limit: 10}); err != nil {
		t.Fatal(err)
	}
	if err := f.writer.QueryRow("SELECT text FROM memory_entries WHERE id='fact'").Scan(&after); err != nil || before != after {
		t.Fatal("query changed authoritative authored content", err)
	}
	if err := f.store.WriteNote(t.Context(), "identity.md", "Fresh reference"); err != nil {
		t.Fatal(err)
	}
	var revision, indexed int64
	if err := f.writer.QueryRow("SELECT revision,search_revision FROM memory_meta").Scan(&revision, &indexed); err != nil || revision == indexed {
		t.Fatal("write did not invalidate its index", err)
	}
	if _, err := f.reader.Search(context.Background(), PreparedQuery{}, SearchOptions{Limit: 10}); err != nil {
		t.Fatal("empty search could not refresh a valid stale index", err)
	}
	if err := f.writer.QueryRow("SELECT revision,search_revision FROM memory_meta").Scan(&revision, &indexed); err != nil || revision != indexed {
		t.Fatal("current index was not bound to the authority revision", err)
	}
	if _, err := f.writer.Exec("UPDATE memory_meta SET revision=-1"); err == nil {
		t.Fatal("schema admitted a negative authority revision")
	}
	if _, err := f.writer.Exec("PRAGMA ignore_check_constraints=ON; UPDATE memory_meta SET revision=-1; PRAGMA ignore_check_constraints=OFF"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.reader.Search(context.Background(), PreparedQuery{}, SearchOptions{Limit: 10}); !errors.Is(err, ErrUnavailable) {
		t.Fatal("schema rejection did not retain its bounded operational failure", err)
	}
	var damaged int64
	if err := f.writer.QueryRow("SELECT revision FROM memory_meta").Scan(&damaged); err != nil || damaged != -1 {
		t.Fatal("failed query guessed a repair or committed a new authority revision", err)
	}
	if _, err := f.writer.Exec("UPDATE memory_meta SET revision=?,search_revision=?", revision, indexed); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.reader.Search(ctx, PreparedQuery{}, SearchOptions{Limit: 10}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	f.store.Close()
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
		if _, err := f.writer.Exec("UPDATE memory_entries SET source_json=? WHERE id='fact'", source); err != nil {
			t.Fatal(err)
		}
		if _, err := f.writer.Exec("UPDATE memory_meta SET search_revision=revision"); err != nil {
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

func TestIntegralRealFTSTimestampsMatchIntegerAuthorityWithoutCoercion(t *testing.T) {
	f := newFixture(t)
	query := PreparedQuery{Terms: []string{"cobalt"}}
	for _, timestamp := range []int64{1, 1760000000000, maxTimestamp} {
		id := fmt.Sprintf("time-%d", timestamp)
		f.add(t, fixtureDocument{id: id, text: "cobalt", updated: ptr(timestamp)})
	}
	// SQLite may store an integral REAL in an untyped FTS column while the
	// authoritative table stores the same value with INTEGER affinity.
	if _, err := f.writer.Exec("UPDATE memory_search SET updated_at=CAST(updated_at AS REAL)"); err != nil {
		t.Fatal(err)
	}
	var indexedType, authorityType string
	if err := f.writer.QueryRow("SELECT typeof(s.updated_at),typeof(a.updated_at) FROM memory_search s JOIN memory_entries a ON a.id=s.document_key LIMIT 1").Scan(&indexedType, &authorityType); err != nil || indexedType != "real" || authorityType != "integer" {
		t.Fatal("fixture did not preserve the distinct SQLite number types", err)
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

func TestConcurrentStoreReadsKeepTheirExactConversationScope(t *testing.T) {
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
}

func TestMalformedStoreSchemaCannotLookLikeAnEmptySuccessfulSearch(t *testing.T) {
	for _, statement := range []string{"PRAGMA user_version=2", "ALTER TABLE notes ADD COLUMN unexpected TEXT"} {
		t.Run(statement, func(t *testing.T) {
			f := newFixture(t)
			if _, err := f.writer.Exec(statement); err != nil {
				t.Fatal(err)
			}
			if _, err := f.store.Search(t.Context(), "", SearchOptions{Limit: 10}); !errors.Is(err, ErrInvalidSnapshot) {
				t.Fatal("invalid authoritative schema was accepted as an empty result", err)
			}
		})
	}
}

func BenchmarkMemoryRetrieve(b *testing.B) {
	f := newFixture(b)
	for index := 0; index < 1000; index++ {
		f.add(b, fixtureDocument{id: fmt.Sprintf("fact-%04d", index), text: "Python renderer uses Cairo. " + strings.Repeat("reference text ", 12), conversation: ptr(fmt.Sprintf("conv-%d", index%16))})
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
	for index := 0; index < 1000; index++ {
		f.add(b, fixtureDocument{id: fmt.Sprintf("fact-%04d", index), text: "Python renderer uses Cairo."})
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
