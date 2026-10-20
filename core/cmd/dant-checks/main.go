package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/Stephen-Sim/dant/core/internal/devcheck"
)

func main() {
	flags := flag.NewFlagSet("dant-checks", flag.ContinueOnError)
	root := flags.String("root", "", "absolute repository root")
	if err := flags.Parse(os.Args[1:]); err != nil || flags.NArg() != 0 || *root == "" {
		os.Exit(2)
	}
	if err := devcheck.RunStateContracts(context.Background(), *root, os.Stdout); err != nil {
		if !errors.Is(err, devcheck.ErrStateViolations) {
			fmt.Fprintln(os.Stderr, "Go state contract check could not be completed.")
		}
		os.Exit(1)
	}
}
