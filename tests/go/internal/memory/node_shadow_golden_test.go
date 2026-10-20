package memory

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const nodeOracleCommit = "d058bdc7509efce90bd9d96cc367b04e11c98bae"

func readNodeGolden(t testing.TB, name string) []byte {
	t.Helper()
	if !slices.Contains([]string{"node-memory-goldens.json", "node-writer-golden.json", "node-shadow-golden.json"}, name) {
		t.Fatal("unknown synthetic Node golden")
	}
	// Go's overlay compiles centralized tests in their owning package; runtime
	// fixture reads still resolve from core/internal/memory.
	file := filepath.Join("..", "..", "..", "tests", "go", "internal", "memory", "testdata", name)
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal("synthetic Node golden unavailable")
	}
	return data
}

type nodeGoldenTable struct {
	Name    string              `json:"name"`
	SQL     string              `json:"sql"`
	Columns []string            `json:"columns"`
	Rows    [][]json.RawMessage `json:"rows"`
}

type nodeGoldenDatabase struct {
	UserVersion int               `json:"userVersion"`
	Tables      []nodeGoldenTable `json:"tables"`
}

type nodeReadGolden struct {
	Version    int `json:"version"`
	Provenance struct {
		Node    string `json:"node"`
		Commit  string `json:"commit"`
		Sources []struct {
			SHA256        string `json:"sha256"`
			MatchesCommit bool   `json:"matchesCommit"`
		} `json:"sources"`
	} `json:"provenance"`
	Revision      int64              `json:"revision"`
	Snapshot      nodeGoldenDatabase `json:"snapshot"`
	Authoritative nodeGoldenDatabase `json:"authoritative"`
	Cases         []struct {
		Name   string `json:"name"`
		Method string `json:"method"`
		Input  string `json:"input"`
		Params struct {
			Query          PreparedQuery `json:"query"`
			Limit          *int          `json:"limit"`
			ConversationID *string       `json:"conversationId"`
			Scope          Scope         `json:"scope"`
		} `json:"params"`
		Expected json.RawMessage `json:"expected"`
	} `json:"cases"`
}

func decodeNodeReadGolden(t testing.TB) nodeReadGolden {
	t.Helper()
	var result nodeReadGolden
	if json.Unmarshal(readNodeGolden(t, "node-shadow-golden.json"), &result) != nil || result.Version != 1 || result.Provenance.Node != "22.23.3" || result.Provenance.Commit != nodeOracleCommit || len(result.Cases) != 30 || len(result.Provenance.Sources) == 0 {
		t.Fatal("unknown synthetic Node reference provenance")
	}
	for _, source := range result.Provenance.Sources {
		if len(source.SHA256) != 64 || !source.MatchesCommit {
			t.Fatal("Node reference was not captured from the recorded source")
		}
	}
	return result
}

func goldenSQLValue(t testing.TB, raw json.RawMessage) any {
	t.Helper()
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		t.Fatal("invalid synthetic SQL value")
	}
	if number, ok := value.(json.Number); ok {
		if integer, err := number.Int64(); err == nil {
			return integer
		}
		floating, err := number.Float64()
		if err != nil || math.IsInf(floating, 0) || math.IsNaN(floating) {
			t.Fatal("invalid synthetic SQL number")
		}
		return floating
	}
	if value != nil {
		if _, ok := value.(string); !ok {
			t.Fatal("non-scalar synthetic SQL value")
		}
	}
	return value
}

func insertGoldenTable(t testing.TB, db *sql.DB, table nodeGoldenTable) {
	t.Helper()
	if !slices.Contains([]string{"memory_meta", "notes", "projects", "memory_entries", "memory_search", "memory_read_documents"}, table.Name) || len(table.Columns) == 0 {
		t.Fatal("unknown synthetic SQL table")
	}
	for _, column := range table.Columns {
		if strings.Trim(column, "abcdefghijklmnopqrstuvwxyz_") != "" || column == "" {
			t.Fatal("invalid synthetic SQL column")
		}
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(table.Columns)), ",")
	query := "INSERT INTO " + table.Name + "(" + strings.Join(table.Columns, ",") + ") VALUES(" + placeholders + ")"
	for _, row := range table.Rows {
		if len(row) != len(table.Columns) {
			t.Fatal("invalid synthetic SQL row")
		}
		values := make([]any, len(row))
		for index, raw := range row {
			values[index] = goldenSQLValue(t, raw)
		}
		if _, err := db.ExecContext(context.Background(), query, values...); err != nil {
			t.Fatal("synthetic Node row could not be reconstructed", table.Name)
		}
	}
}

func reconstructNodeDatabase(t testing.TB, file string, fixture nodeGoldenDatabase) {
	t.Helper()
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=" + strconv.Itoa(fixture.UserVersion)); err != nil {
		t.Fatal(err)
	}
	for _, table := range fixture.Tables {
		// Only immutable, source-attributed synthetic fixture SQL is replayed.
		if _, err := db.Exec(table.SQL); err != nil {
			t.Fatal("synthetic Node schema could not be reconstructed")
		}
		insertGoldenTable(t, db, table)
	}
}

func compareNodeReferences(t testing.TB, actual any, expected json.RawMessage) {
	t.Helper()
	encoded, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	var got, want []map[string]any
	if json.Unmarshal(encoded, &got) != nil || json.Unmarshal(expected, &want) != nil || len(got) != len(want) {
		t.Fatal("Node reference count differs")
	}
	for index := range want {
		actualScore, actualOK := got[index]["score"].(float64)
		expectedScore, expectedOK := want[index]["score"].(float64)
		delete(got[index], "score")
		delete(want[index], "score")
		if !actualOK || !expectedOK || math.Abs(actualScore-expectedScore) > 1e-10 || !reflect.DeepEqual(got[index], want[index]) {
			t.Fatalf("ordered Node reference %d differs", index)
		}
	}
	var actualRaw, expectedRaw []map[string]json.RawMessage
	if json.Unmarshal(encoded, &actualRaw) != nil || json.Unmarshal(expected, &expectedRaw) != nil {
		t.Fatal("invalid encoded Node reference")
	}
	for index := range expectedRaw {
		actualUnits, actualErr := contracts.DecodeJSONTextUnits(actualRaw[index]["text"])
		expectedUnits, expectedErr := contracts.DecodeJSONTextUnits(expectedRaw[index]["text"])
		if actualErr != nil || expectedErr != nil || !slices.Equal(actualUnits, expectedUnits) {
			t.Fatal("Node UTF-16 text units differ")
		}
	}
}

func TestNodeGoldenPreparedReaderAndProductionStoreMatchIndependentReferences(t *testing.T) {
	golden := decodeNodeReadGolden(t)
	ctx := t.Context()
	snapshot := filepath.Join(t.TempDir(), "snapshot.sqlite")
	reconstructNodeDatabase(t, snapshot, golden.Snapshot)
	db, err := sql.Open("sqlite", snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	reader, err := NewReader(ctx, db, golden.Revision)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	directory := filepath.Join(root, "memory", "dant")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	reconstructNodeDatabase(t, filepath.Join(directory, "memory.sqlite"), golden.Authoritative)
	store, err := OpenStore(ctx, root, StoreOptions{})
	if err != nil {
		t.Fatal("Node authoritative fixture failed the production Store boundary", err)
	}
	defer store.Close()
	// Open intentionally marks search stale. Restore the captured synthetic FTS
	// corruption after open to test authoritative validation in both read paths.
	if err := store.connection(ctx, func(db *sql.DB) error {
		for _, table := range golden.Authoritative.Tables {
			if table.Name == "memory_search" {
				if _, err := db.ExecContext(ctx, "DELETE FROM memory_search"); err != nil {
					return err
				}
				insertGoldenTable(t, db, table)
			}
		}
		_, err := db.ExecContext(ctx, "UPDATE memory_meta SET search_revision=revision WHERE id=1")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for _, read := range golden.Cases {
		t.Run(read.Name, func(t *testing.T) {
			limit := DefaultSearchLimit
			if read.Method == "retrieve" {
				limit = DefaultRetrieveLimit
			}
			if read.Params.Limit != nil {
				limit = *read.Params.Limit
			}
			var prepared PreparedQuery
			var fromReader, fromStore any
			var err error
			switch read.Method {
			case "search":
				prepared, err = PrepareSearch(read.Input)
				if err == nil {
					fromReader, err = reader.Search(ctx, read.Params.Query, SearchOptions{Limit: limit, ConversationID: read.Params.ConversationID})
				}
				if err == nil {
					fromStore, err = store.Search(ctx, read.Input, SearchOptions{Limit: limit, ConversationID: read.Params.ConversationID})
				}
			case "retrieve":
				prepared, err = PrepareRetrieval(read.Input)
				if err == nil {
					fromReader, err = reader.Retrieve(ctx, read.Params.Query, read.Params.Scope, RetrieveOptions{Limit: limit})
				}
				if err == nil {
					fromStore, err = store.Retrieve(ctx, read.Input, read.Params.Scope, RetrieveOptions{Limit: limit})
				}
			default:
				t.Fatal("unknown golden read method")
			}
			if err != nil || !reflect.DeepEqual(prepared, read.Params.Query) {
				t.Fatal("prepared query or read differs from Node", err)
			}
			compareNodeReferences(t, fromReader, read.Expected)
			compareNodeReferences(t, fromStore, read.Expected)
		})
	}
}
