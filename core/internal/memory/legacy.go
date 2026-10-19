package memory

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

type LegacyPersistence interface {
	Snapshot() contracts.State
	Mutate(context.Context, func(*contracts.State) error) error
}

func (s *Store) backupJSON(label string, raw []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.backupJSONLocked(label, raw)
}

func (s *Store) backupJSONLocked(label string, raw []byte) error {
	if err := s.guard(); err != nil {
		return err
	}
	directory := filepath.Join(s.dir, label+"-backup-"+newUUID())
	if err := os.Mkdir(directory, 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(directory, "memory.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = file.Write(raw)
	if err == nil {
		err = file.Sync()
	}
	closed := file.Close()
	if err != nil {
		return err
	}
	return closed
}

func (s *Store) MigrateProjects(ctx context.Context, conversation string, records []contracts.WorkRecord) error {
	if !validID(conversation) {
		return ErrInvalidScope
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.transaction(ctx, true, func(tx *sql.Tx) error {
		pending := []contracts.WorkRecord{}
		type prepared struct {
			id   string
			data []byte
		}
		validated := []prepared{}
		for _, record := range records {
			if len(record.ProjectContext) == 0 {
				continue
			}
			if !validID(record.ID) {
				return ErrInvalidScope
			}
			var present int
			err := tx.QueryRowContext(ctx, "SELECT 1 FROM projects WHERE conversation_id=? AND work_id=?", conversation, record.ID).Scan(&present)
			if err == nil {
				continue
			}
			if err != sql.ErrNoRows {
				return err
			}
			raw, err := marshalJS(record.ProjectContext)
			if err != nil {
				return ErrInvalidMemory
			}
			project, err := SafeProjectContext(raw)
			if err != nil {
				return err
			}
			data, err := marshalJS(project)
			if err != nil || len(data) > MaxNoteBytes {
				return ErrInvalidMemory
			}
			pending = append(pending, record)
			validated = append(validated, prepared{record.ID, data})
		}
		if len(pending) > 0 {
			raw, err := marshalJS(struct {
				ConversationID string                 `json:"conversationId"`
				Records        []contracts.WorkRecord `json:"records"`
			}{conversation, pending})
			if err != nil {
				return ErrInvalidMemory
			}
			if err = s.backupJSONLocked("projects", raw); err != nil {
				return err
			}
		}
		for _, record := range validated {
			if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO projects(conversation_id,work_id,context_json) VALUES(?,?,?)", conversation, record.id, string(record.data)); err != nil {
				return err
			}
		}
		return nil
	})
}

// MigrateLegacy is startup-only under the process ownership fence. It backs up
// source records before imports and never overwrites already-migrated projects.
func (s *Store) MigrateLegacy(ctx context.Context, persistence LegacyPersistence) error {
	state := persistence.Snapshot()
	if err := s.MigrateProjects(ctx, state.ConversationID, state.WorkTasks); err != nil {
		return err
	}
	var version int
	if json.Unmarshal(state.MemoryMigration["version"], &version) == nil && version == 1 {
		text, err := s.ReadNote(ctx, "working-memory.md")
		if err != nil {
			return err
		}
		return persistence.Mutate(ctx, func(current *contracts.State) error {
			if current.ConversationID != state.ConversationID {
				return ErrConflict
			}
			current.Memory = text
			return nil
		})
	}
	existing, err := s.ReadNote(ctx, "working-memory.md")
	if err != nil {
		return err
	}
	legacy := state.Memory
	if legacy != "" && existing == "" {
		raw, _ := json.Marshal(struct {
			Memory string `json:"memory"`
		}{legacy})
		if original, ok := state.LegacyText.Original["memory"]; ok {
			raw, _ = json.Marshal(contracts.RawObject{"memory": original})
		}
		if err = s.backupJSON("legacy-state", raw); err != nil {
			return err
		}
		bounded := legacy
		if len(bounded) > MaxNoteBytes {
			bounded = bounded[:MaxNoteBytes]
			for !utf8.ValidString(bounded) {
				bounded = bounded[:len(bounded)-1]
			}
		}
		if err = s.WriteNote(ctx, "working-memory.md", bounded); err != nil {
			return err
		}
	}
	text, err := s.ReadNote(ctx, "working-memory.md")
	if err != nil {
		return err
	}
	at := s.now().UnixMilli()
	return persistence.Mutate(ctx, func(current *contracts.State) error {
		if current.ConversationID != state.ConversationID {
			return ErrConflict
		}
		current.Memory = text
		current.MemoryMigration = contracts.RawObject{"version": json.RawMessage("1")}
		current.MemoryMigration["completedAt"], _ = json.Marshal(at)
		current.MemoryMigration["truncated"], _ = json.Marshal(len(legacy) > MaxNoteBytes)
		return nil
	})
}
