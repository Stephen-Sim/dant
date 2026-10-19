package voice

import (
	"encoding/json"
	"strconv"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func textField(object contracts.RawObject, key string) string {
	var value string
	_ = json.Unmarshal(object[key], &value)
	return value
}

func objectField(object contracts.RawObject, key string) contracts.RawObject {
	value, err := contracts.DecodeObject(object[key], 2*1024*1024)
	if err != nil {
		return contracts.RawObject{}
	}
	return value
}

func fmtInt(value int) string { return strconv.Itoa(value) }
func rawValue(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return raw
}

func object(values map[string]any) contracts.RawObject {
	result := contracts.RawObject{}
	for key, value := range values {
		result[key] = rawValue(value)
	}
	return result
}
