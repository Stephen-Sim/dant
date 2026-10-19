package settings

import (
	"bytes"
	"encoding/json"
	"sort"
)

// The Node receipt object preserves insertion order. It matters when distinct
// sources share a millisecond: snapshot.lastResponse selects the last receipt.
func orderedKeys(raw json.RawMessage) []string {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil
	}
	result := []string{}
	for decoder.More() {
		token, err = decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok {
			return nil
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return nil
		}
		result = append(result, key)
	}
	return result
}

func recordKeys[T any](order []string, records map[string]T) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, key := range order {
		if _, ok := records[key]; ok && !seen[key] {
			result = append(result, key)
			seen[key] = true
		}
	}
	remaining := []string{}
	for key := range records {
		if !seen[key] {
			remaining = append(remaining, key)
		}
	}
	sort.Strings(remaining)
	return append(result, remaining...)
}

func orderedRecords[T any](order []string, records map[string]T) (json.RawMessage, error) {
	var out bytes.Buffer
	out.WriteByte('{')
	for index, key := range recordKeys(order, records) {
		if index > 0 {
			out.WriteByte(',')
		}
		name, _ := json.Marshal(key)
		value, err := json.Marshal(records[key])
		if err != nil {
			return nil, err
		}
		out.Write(name)
		out.WriteByte(':')
		out.Write(value)
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

func (state TokenState) MarshalJSON() ([]byte, error) {
	native, err := orderedRecords(state.nativeOrder, state.Native)
	if err != nil {
		return nil, err
	}
	api, err := orderedRecords(state.apiOrder, state.APIVoice)
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		Version       int             `json:"version"`
		RecordedSince *int64          `json:"recordedSince"`
		Native        json.RawMessage `json:"native"`
		APIVoice      json.RawMessage `json:"apiVoice"`
		Activity      Activity        `json:"activity"`
	}{state.Version, state.RecordedSince, native, api, state.Activity})
}
