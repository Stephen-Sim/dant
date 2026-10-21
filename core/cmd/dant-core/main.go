package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/Stephen-Sim/dant/core/internal/application"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := application.Run(ctx, os.Args[1:], os.Stdin, os.Stdout); err != nil {
		// Never print arguments, paths, query content, SQL errors or credentials.
		fmt.Fprintln(os.Stderr, "The dant service could not complete its request.")
		os.Exit(1)
	}
}
