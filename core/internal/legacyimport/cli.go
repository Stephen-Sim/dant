package legacyimport

import (
	"context"
	"encoding/json"
	"io"
	"strings"
)

// RunCLI accepts exactly the two explicit directory arguments. It deliberately
// does not load environment files, host credentials or a service configuration.
func RunCLI(ctx context.Context, args []string, output io.Writer) error {
	options := Options{}
	seen := map[string]bool{}
	for index := 0; index < len(args); index++ {
		key, value, joined := strings.Cut(args[index], "=")
		if (key != "--source-dir" && key != "--data-dir") || seen[key] {
			return ErrInvalid
		}
		seen[key] = true
		if !joined {
			index++
			if index == len(args) {
				return ErrInvalid
			}
			value = args[index]
		}
		if key == "--source-dir" {
			options.SourceDir = value
		} else {
			options.TargetDir = value
		}
	}
	if !seen["--source-dir"] || !seen["--data-dir"] || output == nil {
		return ErrInvalid
	}
	result, err := Import(ctx, options)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}
