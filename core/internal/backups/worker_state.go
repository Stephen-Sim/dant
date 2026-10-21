package backups

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/schedules"
	"github.com/Stephen-Sim/dant/core/internal/store"
)

const restoreJSONMaxBytes = 128 * 1024 * 1024

// PrepareRestoredWorkerState only operates on an already validated private
// archive tree. Historical identities survive; executors and integrations stay
// stopped until the user explicitly resumes them.
func PrepareRestoredWorkerState(ctx context.Context, directory string) error {
	data, err := files.OrdinaryDirectory(filepath.Join(directory, "data"), false)
	if err != nil {
		return ErrInvalid
	}
	ownerFile := filepath.Join(data, ".dant-core-owner.lock")
	if _, err := files.ReadRegular(ownerFile, restoreJournalMaxBytes); err == nil {
		if err := os.Remove(ownerFile); err != nil {
			return ErrInvalid
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrInvalid
	}
	name := filepath.Join(data, "state.json")
	raw, err := files.ReadRegular(name, restoreJSONMaxBytes)
	if err != nil {
		return ErrInvalid
	}
	paused, err := store.PauseRestoredState(raw)
	if err != nil {
		return ErrInvalid
	}
	object, err := contracts.DecodeObject(paused, restoreJSONMaxBytes)
	if err != nil {
		return ErrInvalid
	}

	if raw, exists := object["schedules"]; exists {
		var records []json.RawMessage
		if json.Unmarshal(raw, &records) != nil {
			return ErrInvalid
		}
		for index, record := range records {
			entry, err := pauseScheduleJSON(record)
			if err != nil {
				return err
			}
			records[index] = entry
		}
		object["schedules"], _ = json.Marshal(records)
	}
	paused, err = json.Marshal(object)
	if err != nil || files.WriteAtomic(ctx, name, paused, 0600) != nil {
		return ErrInvalid
	}
	for _, database := range []struct {
		path     string
		validate func(context.Context, string) error
	}{
		{filepath.Join(data, "schedules", "schedules.sqlite"), schedules.PauseRestoredDatabase},
		{filepath.Join(data, "memory", "dant", "memory.sqlite"), memory.ValidateBackupDatabase},
	} {
		if _, err := os.Lstat(database.path); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return ErrInvalid
		}
		if err := database.validate(ctx, database.path); err != nil {
			return ErrInvalid
		}
	}
	telegram := filepath.Join(data, "telegram.json")
	raw, err = files.ReadRegular(telegram, restoreJSONMaxBytes)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}

	if err != nil {
		return ErrInvalid
	}
	config, err := contracts.DecodeObject(raw, restoreJSONMaxBytes)
	if err != nil {
		return ErrInvalid
	}
	config["enabled"] = json.RawMessage("false")
	if raw, exists := config["outbox"]; exists {
		var entries []json.RawMessage
		if json.Unmarshal(raw, &entries) == nil {
			for index, raw := range entries {
				entry, err := contracts.DecodeObject(raw, restoreJSONMaxBytes)
				if err != nil {
					continue
				}
				var status string
				_ = json.Unmarshal(entry["status"], &status)
				if status == "queued" || status == "sending" {
					entry["status"] = json.RawMessage(`"unknown"`)
					entries[index], _ = json.Marshal(entry)
				}
			}
			config["outbox"], _ = json.Marshal(entries)
		}
	}
	raw, err = json.Marshal(config)
	if err != nil {
		return ErrInvalid
	}

	return files.WriteAtomic(ctx, telegram, raw, 0600)
}

func pauseScheduleJSON(raw []byte) ([]byte, error) {
	record, err := contracts.DecodeObject(raw, restoreJSONMaxBytes)
	if err != nil {
		return nil, ErrInvalid
	}
	record["enabled"] = json.RawMessage("false")
	var status string
	_ = json.Unmarshal(record["status"], &status)
	if status != string(contracts.ScheduleStatusDispatched) {
		record["status"] = json.RawMessage(`"paused"`)
	}
	result, err := json.Marshal(record)
	if err != nil {
		return nil, ErrInvalid
	}

	return result, nil
}
