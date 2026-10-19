// Package shadow owns the opt-in, read-only memory shadow process lifecycle.
package shadow

import (
	"context"
	"io"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/memory"
	"github.com/Stephen-Sim/dant/core/internal/memory/stdio"
	"github.com/Stephen-Sim/dant/core/internal/transport"
)

const startupTimeout = 10 * time.Second

// Run serves only the explicit memory-shadow role over inherited stdio. It
// never opens a network listener, live store or execution engine.
func Run(ctx context.Context, arguments []string, input io.Reader, output io.Writer) error {
	options, err := parseOptions(arguments)
	if err != nil {
		return err
	}
	startup, cancel := context.WithTimeout(ctx, startupTimeout)
	defer cancel()
	snapshot, err := openSnapshot(startup, options.snapshot)
	if err != nil {
		return err
	}
	defer snapshot.close()
	reader, err := memory.NewReader(startup, snapshot.db, options.revision)
	if err != nil {
		return stdio.Error(err)
	}
	return transport.Serve(ctx, input, output, stdio.NewHandler(snapshot.unchanged, reader, options.revision))
}
