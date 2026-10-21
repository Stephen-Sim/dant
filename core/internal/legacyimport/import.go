package legacyimport

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/Stephen-Sim/dant/core/internal/ownership"
)

func importPaths(options Options) (Options, error) {
	for _, value := range []string{options.SourceDir, options.TargetDir} {
		if !filepath.IsAbs(value) || !utf8.ValidString(value) || strings.ContainsAny(value, "\x00\r\n") {
			return Options{}, ErrInvalid
		}
	}
	options.SourceDir = filepath.Clean(options.SourceDir)
	options.TargetDir = filepath.Clean(options.TargetDir)
	for _, pair := range [][2]string{{options.SourceDir, options.TargetDir}, {options.TargetDir, options.SourceDir}} {
		relative, err := filepath.Rel(pair[0], pair[1])
		if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative) {
			return Options{}, ErrInvalid
		}
	}
	return options, nil
}

// Import is an operator action for a new or verified-empty data root. Once the
// durable journal exists, any incomplete result needs independent reconciliation;
// this function never resumes partial writes or repeats their attachment mapping.
func Import(ctx context.Context, options Options) (result Result, failure error) {
	defer func() {
		if failure != nil && ctx.Err() != nil {
			failure = ctx.Err()
		}
	}()
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	options, err := importPaths(options)
	if err != nil {
		return Result{}, err
	}
	value, err := readSource(ctx, options.SourceDir)
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		return Result{}, err
	}
	defer value.root.Close()
	if value.manifest == nil {
		return Result{OK: true, Skipped: true}, nil
	}

	owner, err := ownership.Acquire(ctx, options.TargetDir)
	if errors.Is(err, ownership.ErrBusy) {
		return Result{}, ErrBusy
	}
	if err != nil {
		return Result{}, ErrInvalid
	}
	defer owner.Close()
	target, err := openDestination(options.TargetDir)
	if err != nil {
		return Result{}, err
	}
	defer target.close()
	lockIdentity, err := target.root.Lstat(ownerLockName)
	if err != nil || !lockIdentity.Mode().IsRegular() {
		return Result{}, ErrChanged
	}
	current := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		currentLock, err := target.root.Lstat(ownerLockName)
		if err != nil || !os.SameFile(lockIdentity, currentLock) || !owner.Current() || !target.managed.Unchanged() {
			return ErrChanged
		}
		return value.unchanged(ctx)
	}
	if err := current(); err != nil {
		return Result{}, err
	}

	if raw, err := target.managed.ReadFile(ctx, receiptName, receiptMaxBytes); err == nil {
		result, err := value.existing(ctx, options, target, raw)
		if err == nil {
			err = current()
		}
		return result, err
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, ErrUnconfirmed
	}
	entries, err := target.managed.ReadDirectory(".")
	if err != nil {
		return Result{}, ErrChanged
	}
	for _, entry := range entries {
		if entry.Name() == ownerLockName {
			continue
		}
		if entry.Name() == journalName || entry.Name() == completionName {
			return Result{}, ErrUnconfirmed
		}
		return Result{}, ErrConflict
	}

	return value.publishImport(ctx, options, target, current, target.exclusive)
}
