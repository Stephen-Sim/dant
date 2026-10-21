package telegram

import (
	"bytes"
	"encoding/json"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

// ValidateBackupConfig checks the persisted schema without writing or applying
// restored receipt transitions to a live gateway.
func ValidateBackupConfig(data []byte) error {
	_, _, err := restoreConfig(data)
	return err
}

func ReadConfigure(value contracts.RawObject) (ConfigureInput, error) {
	var input ConfigureInput
	for key, data := range value {
		if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
			return input, ErrConfig
		}
		switch key {
		case "token":
			var token string
			if json.Unmarshal(data, &token) != nil {
				return input, ErrConfig
			}
			input.Token = &token
		case "enabled":
			var enabled bool
			if json.Unmarshal(data, &enabled) != nil {
				return input, ErrConfig
			}
			input.Enabled = &enabled
		case "forwardMode":
			var mode ForwardMode
			if json.Unmarshal(data, &mode) != nil || mode != ForwardUnread && mode != ForwardAll {
				return input, ErrConfig
			}
			input.ForwardMode = &mode
		case "combineReplies":
			var combine bool
			if json.Unmarshal(data, &combine) != nil {
				return input, ErrConfig
			}
			input.CombineReplies = &combine
		default:
			return input, ErrConfig
		}
	}
	return input, nil
}

func ReadUpdate(data []byte) (Update, error) {
	var update Update
	value, err := contracts.DecodeObject(data, MaxResponseBytes)
	if err != nil || value["update_id"] == nil || !contracts.ValidUnicodeJSON(data) || json.Unmarshal(data, &update) != nil || update.ID < 0 || update.ID >= 9007199254740991 {
		return update, ErrIncoming
	}
	return update, nil
}
