package legacyimport

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
)

// publishImport owns the ordered durable publications after the caller has
// acquired its destination and verified an empty target. A failed publication
// leaves its existing evidence in place; the operator must reconcile it.
func (value *source) publishImport(
	ctx context.Context,
	options Options,
	target *destination,
	current func() error,
	publish func(context.Context, string, []byte) error,
) (Result, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return Result{}, ErrUnconfirmed
	}
	intent := journal{
		SchemaVersion: 1, AttemptID: id.String(), ManifestID: value.id,
		SourceDir: options.SourceDir, TargetDir: options.TargetDir,
		ManifestSHA256: hash(value.manifestRaw), SourceStateSHA256: hash(value.stateRaw), Files: value.files,
	}
	encodedIntent, err := json.Marshal(intent)
	if err != nil || len(encodedIntent) > receiptMaxBytes {
		return Result{}, ErrCapacity
	}
	if err := publish(ctx, journalName, encodedIntent); err != nil {
		return Result{}, err
	}

	if err := publish(ctx, originalManifestName, value.manifestRaw); err != nil {
		return Result{}, err
	}
	if err := publish(ctx, originalStateName, value.stateRaw); err != nil {
		return Result{}, err
	}

	mapped, archived, warnings, err := value.archive(ctx, target, options.TargetDir)
	if err != nil {
		return Result{}, err
	}
	if err := current(); err != nil {
		return Result{}, err
	}
	state, err := value.transform(mapped, warnings)
	if err != nil {
		return Result{}, err
	}
	if err := publish(ctx, stateName, state); err != nil {
		return Result{}, err
	}

	proof := importProof{
		SchemaVersion: 1, AttemptID: intent.AttemptID, JournalSHA256: hash(encodedIntent),
		StateSHA256: hash(state), Files: archived,
	}
	receipt := copyObject(value.manifest)
	receipt["warnings"] = wire(warnings)
	receipt["proof"] = wire(proof)
	encodedReceipt, err := json.Marshal(receipt)
	if err != nil || len(encodedReceipt) > receiptMaxBytes {
		return Result{}, ErrCapacity
	}
	if err := publish(ctx, receiptName, encodedReceipt); err != nil {
		return Result{}, err
	}

	if err := value.verifyOutputs(ctx, options, target, intent, proof); err != nil {
		return Result{}, err
	}
	if err := current(); err != nil {
		return Result{}, err
	}

	complete := completion{
		SchemaVersion: 1, AttemptID: intent.AttemptID,
		JournalSHA256: hash(encodedIntent), ReceiptSHA256: hash(encodedReceipt),
	}
	if err := publish(ctx, completionName, wire(complete)); err != nil {
		return Result{}, err
	}
	return Result{OK: true, Files: len(archived), Unavailable: len(warnings)}, nil
}
