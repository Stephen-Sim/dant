package memory

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

const entryColumns = "id,kind,text,memory_key,status,source_json,confidence,conflicts_json,created_at,updated_at"

type entryScanner interface{ Scan(...any) error }

func decodeEntry(record entryScanner) (*Entry, error) {
	var entry Entry
	var source, conflicts string
	var confidence sql.NullFloat64
	var created, updated sql.NullInt64
	err := record.Scan(&entry.ID, &entry.Kind, &entry.Text, &entry.Key, &entry.Status, &source, &confidence, &conflicts, timestampScanner{&created}, timestampScanner{&updated})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, ErrInvalidSnapshot
	}
	parsed, err := parseSource(source)
	if err != nil {
		return nil, err
	}
	if json.Unmarshal([]byte(conflicts), &entry.ConflictsWith) != nil || entry.ConflictsWith == nil {
		return nil, ErrInvalidSnapshot
	}
	for _, id := range entry.ConflictsWith {
		if !validID(id) {
			return nil, ErrInvalidSnapshot
		}
	}
	if !validID(entry.ID) || (entry.Kind != "semantic" && entry.Kind != "episodic") || !entry.Status.Valid() || !validEntryText(entry.Text) || !created.Valid || !updated.Valid {
		return nil, ErrInvalidSnapshot
	}
	entry.Source = *parsed
	entry.CreatedAt = created.Int64
	entry.UpdatedAt = updated.Int64
	if confidence.Valid {
		if math.IsNaN(confidence.Float64) || math.IsInf(confidence.Float64, 0) || confidence.Float64 < 0 || confidence.Float64 > 1 {
			return nil, ErrInvalidSnapshot
		}
		entry.Confidence = &confidence.Float64
	}
	return &entry, nil
}

func validEntryText(text string) bool {
	return utf8.ValidString(text) && contracts.TrimText(text) != "" && !strings.ContainsRune(text, 0) && len(text) <= MaxEntryBytes && !ContainsSecret(text)
}

func validSource(source Source) bool {
	data, err := json.Marshal(source)
	if err != nil {
		return false
	}
	parsed, err := parseSource(string(data))
	if err != nil {
		return false
	}
	for _, value := range []*string{parsed.ConversationID, parsed.WorkID, parsed.MessageID} {
		if value != nil && ContainsSecret(*value) {
			return false
		}
	}
	return true
}

func entryAt(ctx context.Context, tx *sql.Tx, id string) (*Entry, error) {
	if !validID(id) {
		return nil, ErrInvalidMemory
	}
	return decodeEntry(tx.QueryRowContext(ctx, "SELECT "+entryColumns+" FROM memory_entries WHERE id=?", id))
}

func entriesAt(ctx context.Context, tx *sql.Tx, status contracts.MemoryEntryStatus) ([]Entry, error) {
	query := "SELECT " + entryColumns + " FROM memory_entries"
	args := []any{}
	if status != "" {
		if !status.Valid() {
			return nil, ErrInvalidMemory
		}
		query += " WHERE status=?"
		args = append(args, string(status))
	}
	query += " ORDER BY updated_at DESC,id"
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Entry{}
	for rows.Next() {
		entry, err := decodeEntry(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *entry)
	}
	return result, rows.Err()
}

func conflictsAt(ctx context.Context, tx *sql.Tx, kind, key, id string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id FROM memory_entries WHERE kind=? AND memory_key=? AND status=? AND id<>?", kind, key, string(contracts.MemoryEntryStatusConfirmed), id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil || !validID(value) {
			return nil, ErrInvalidSnapshot
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func dedupeEntry(kind, key, text string) string {
	data, _ := marshalJS([]string{kind, key, normalizeKey(text)})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *Store) Entries(ctx context.Context, status contracts.MemoryEntryStatus) ([]Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result []Entry
	err := s.transaction(ctx, false, func(tx *sql.Tx) error {
		var err error
		result, err = entriesAt(ctx, tx, status)
		return err
	})
	return result, err
}

func (s *Store) Propose(ctx context.Context, proposal Proposal) (*Entry, error) {
	if (proposal.Kind != "semantic" && proposal.Kind != "episodic") || !validEntryText(proposal.Text) || !validSource(proposal.Source) || proposal.Confidence != nil && (math.IsNaN(*proposal.Confidence) || math.IsInf(*proposal.Confidence, 0) || *proposal.Confidence < 0 || *proposal.Confidence > 1) {
		return nil, ErrInvalidMemory
	}
	text := contracts.TrimText(proposal.Text)
	key := normalizeKey(text)
	if proposal.Key != nil {
		if !validEntryText(*proposal.Key) {
			return nil, ErrInvalidMemory
		}
		key = normalizeKey(*proposal.Key)
	}
	dedupe := dedupeEntry(proposal.Kind, key, text)
	s.mu.Lock()
	defer s.mu.Unlock()
	var result *Entry
	err := s.transaction(ctx, true, func(tx *sql.Tx) error {
		var err error
		result, err = decodeEntry(tx.QueryRowContext(ctx, "SELECT "+entryColumns+" FROM memory_entries WHERE dedupe=?", dedupe))
		if err != nil || result != nil {
			return err
		}
		var count int
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM memory_entries").Scan(&count); err != nil {
			return err
		}
		if count >= MaxEntries {
			return ErrInvalidMemory
		}
		id := s.newID()
		if !validID(id) {
			return ErrInvalidMemory
		}
		now := s.now().UnixMilli()
		if !validTime(now) {
			return ErrInvalidMemory
		}
		conflicts, err := conflictsAt(ctx, tx, proposal.Kind, key, "")
		if err != nil {
			return err
		}
		status := contracts.MemoryEntryStatusCandidate
		if len(conflicts) > 0 {
			status = contracts.MemoryEntryStatusConflicted
		}
		source, _ := json.Marshal(proposal.Source)
		conflictJSON, _ := json.Marshal(conflicts)
		_, err = tx.ExecContext(ctx, "INSERT INTO memory_entries(id,kind,text,memory_key,dedupe,status,source_json,confidence,conflicts_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, proposal.Kind, text, key, dedupe, string(status), string(source), proposal.Confidence, string(conflictJSON), now, now)
		if err != nil {
			return err
		}
		result, err = entryAt(ctx, tx, id)
		return err
	})
	return result, err
}

func (s *Store) confirmAt(ctx context.Context, tx *sql.Tx, id string, resolve bool) (*Entry, error) {
	entry, err := entryAt(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if entry == nil {
		return nil, ErrNotFound
	}
	conflicts, err := conflictsAt(ctx, tx, entry.Kind, entry.Key, id)
	if err != nil {
		return nil, err
	}
	if len(conflicts) > 0 && !resolve {
		return nil, ErrConflict
	}
	now := s.now().UnixMilli()
	if !validTime(now) {
		return nil, ErrInvalidMemory
	}
	for _, previous := range conflicts {
		if _, err = tx.ExecContext(ctx, "UPDATE memory_entries SET status=?,updated_at=? WHERE id=?", string(contracts.MemoryEntryStatusRejected), now, previous); err != nil {
			return nil, err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE memory_entries SET status=?,conflicts_json='[]',updated_at=? WHERE id=?", string(contracts.MemoryEntryStatusConfirmed), now, id); err != nil {
		return nil, err
	}
	return entryAt(ctx, tx, id)
}

func (s *Store) Confirm(ctx context.Context, id string, resolveConflicts bool) (*Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result *Entry
	err := s.transaction(ctx, true, func(tx *sql.Tx) error {
		var err error
		result, err = s.confirmAt(ctx, tx, id, resolveConflicts)
		return err
	})
	return result, err
}

func (s *Store) updateAt(ctx context.Context, tx *sql.Tx, id string, patch EntryPatch) (*Entry, error) {
	entry, err := entryAt(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if entry == nil {
		return nil, ErrNotFound
	}
	if len(patch) == 0 {
		return nil, ErrInvalidMemory
	}
	for key, raw := range patch {
		if key != "confidence" && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil, ErrInvalidMemory
		}
		switch key {
		case "kind":
			if json.Unmarshal(raw, &entry.Kind) != nil || entry.Kind != "semantic" && entry.Kind != "episodic" {
				return nil, ErrInvalidMemory
			}
		case "text":
			if json.Unmarshal(raw, &entry.Text) != nil || !validEntryText(entry.Text) {
				return nil, ErrInvalidMemory
			}
			entry.Text = contracts.TrimText(entry.Text)
		case "key":
			if json.Unmarshal(raw, &entry.Key) != nil || !validEntryText(entry.Key) {
				return nil, ErrInvalidMemory
			}
			entry.Key = normalizeKey(entry.Key)
		case "source":
			var source Source
			if json.Unmarshal(raw, &source) != nil || !validSource(source) {
				return nil, ErrInvalidMemory
			}
			entry.Source = source
		case "confidence":
			var confidence *float64
			if json.Unmarshal(raw, &confidence) != nil || confidence != nil && (math.IsNaN(*confidence) || math.IsInf(*confidence, 0) || *confidence < 0 || *confidence > 1) {
				return nil, ErrInvalidMemory
			}
			entry.Confidence = confidence
		default:
			return nil, ErrInvalidMemory
		}
	}
	conflicts, err := conflictsAt(ctx, tx, entry.Kind, entry.Key, id)
	if err != nil {
		return nil, err
	}
	status := contracts.MemoryEntryStatusCandidate
	if len(conflicts) > 0 {
		status = contracts.MemoryEntryStatusConflicted
	}
	source, _ := json.Marshal(entry.Source)
	conflictJSON, _ := json.Marshal(conflicts)
	now := s.now().UnixMilli()
	if !validTime(now) {
		return nil, ErrInvalidMemory
	}
	_, err = tx.ExecContext(ctx, "UPDATE memory_entries SET kind=?,text=?,memory_key=?,dedupe=?,status=?,source_json=?,confidence=?,conflicts_json=?,updated_at=? WHERE id=?", entry.Kind, entry.Text, entry.Key, dedupeEntry(entry.Kind, entry.Key, entry.Text), string(status), string(source), entry.Confidence, string(conflictJSON), now, id)
	if err != nil {
		return nil, err
	}
	return entryAt(ctx, tx, id)
}

func (s *Store) Update(ctx context.Context, id string, patch EntryPatch) (*Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result *Entry
	err := s.transaction(ctx, true, func(tx *sql.Tx) error {
		var err error
		result, err = s.updateAt(ctx, tx, id, patch)
		return err
	})
	return result, err
}

func (s *Store) Delete(ctx context.Context, id string) (bool, error) {
	if !validID(id) {
		return false, ErrInvalidMemory
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	deleted := false
	err := s.transaction(ctx, true, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, "DELETE FROM memory_entries WHERE id=?", id)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		deleted = count == 1
		return nil
	})
	return deleted, err
}
