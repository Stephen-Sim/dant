package shadow

import (
	"strconv"
	"strings"

	"github.com/Stephen-Sim/dant/core/internal/memory/stdio"
	"github.com/Stephen-Sim/dant/core/internal/transport"
)

const shadowRole = stdio.Role
const maxRevision = 9_007_199_254_740_991

type options struct {
	snapshot string
	revision int64
}

func parseOptions(arguments []string) (options, error) {
	var value options
	fields := make(map[string]string)
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if !strings.HasPrefix(argument, "--") {
			return value, transport.NewError(transport.InvalidParams)
		}
		name, content, hasValue := strings.Cut(strings.TrimPrefix(argument, "--"), "=")
		if !hasValue {
			index++
			if index >= len(arguments) {
				return value, transport.NewError(transport.InvalidParams)
			}
			content = arguments[index]
		}
		if _, duplicate := fields[name]; duplicate || content == "" {
			return value, transport.NewError(transport.InvalidParams)
		}
		switch name {
		case "role", "snapshot", "revision":
		default:
			return value, transport.NewError(transport.InvalidParams)
		}
		fields[name] = content
	}
	if len(fields) != 3 || fields["role"] != shadowRole {
		return value, transport.NewError(transport.InvalidParams)
	}
	revision := fields["revision"]
	if revision == "" || len(revision) > 16 || len(revision) > 1 && revision[0] == '0' {
		return value, transport.NewError(transport.InvalidParams)
	}
	for _, character := range revision {
		if character < '0' || character > '9' {
			return value, transport.NewError(transport.InvalidParams)
		}
	}
	number, err := strconv.ParseInt(revision, 10, 64)
	if err != nil || number > maxRevision {
		return value, transport.NewError(transport.InvalidParams)
	}
	value.snapshot, value.revision = fields["snapshot"], number
	return value, nil
}
