package legacyimport

import (
	"context"
	"encoding/json"
	"path/filepath"
	"reflect"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/google/uuid"
)

func validUUID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id.String() == value && id.Version() == 4 && id.Variant() == uuid.RFC4122
}

func (value *source) existing(ctx context.Context, options Options, target *destination, receiptRaw []byte) (Result, error) {
	receipt, err := contracts.DecodeObject(receiptRaw, receiptMaxBytes)
	if err != nil {
		return Result{}, ErrUnconfirmed
	}
	id, valid := text(receipt["id"])
	if !valid || id != value.id {
		return Result{}, ErrConflict
	}
	proofFields, err := contracts.DecodeObject(receipt["proof"], receiptMaxBytes)
	var proof importProof
	if err != nil || len(proofFields) != 5 || json.Unmarshal(receipt["proof"], &proof) != nil ||
		proof.SchemaVersion != 1 || !validUUID(proof.AttemptID) || !digestPattern.MatchString(proof.JournalSHA256) || !digestPattern.MatchString(proof.StateSHA256) || proof.Files == nil {
		return Result{}, ErrUnconfirmed
	}
	journalRaw, err := target.managed.ReadFile(ctx, journalName, receiptMaxBytes)
	if err != nil || hash(journalRaw) != proof.JournalSHA256 {
		return Result{}, ErrUnconfirmed
	}
	journalFields, err := contracts.DecodeObject(journalRaw, receiptMaxBytes)
	var intent journal
	if err != nil || len(journalFields) != 8 || json.Unmarshal(journalRaw, &intent) != nil ||
		intent.SchemaVersion != 1 || intent.AttemptID != proof.AttemptID || intent.ManifestID != value.id ||
		intent.SourceDir != options.SourceDir || intent.TargetDir != options.TargetDir ||
		intent.ManifestSHA256 != hash(value.manifestRaw) || intent.SourceStateSHA256 != hash(value.stateRaw) ||
		!reflect.DeepEqual(intent.Files, value.files) {
		return Result{}, ErrUnconfirmed
	}
	completeRaw, err := target.managed.ReadFile(ctx, completionName, manifestMaxBytes)
	completeFields, decodeErr := contracts.DecodeObject(completeRaw, manifestMaxBytes)
	var complete completion
	if err != nil || decodeErr != nil || len(completeFields) != 4 || json.Unmarshal(completeRaw, &complete) != nil ||
		complete.SchemaVersion != 1 || complete.AttemptID != intent.AttemptID ||
		complete.JournalSHA256 != proof.JournalSHA256 || complete.ReceiptSHA256 != hash(receiptRaw) {
		return Result{}, ErrUnconfirmed
	}
	if err := value.verifyOutputs(ctx, options, target, intent, proof); err != nil {
		return Result{}, err
	}
	if err := value.unchanged(ctx); err != nil {
		return Result{}, err
	}
	return Result{OK: true, Existing: true, Files: len(proof.Files), Unavailable: len(intent.Files) - len(proof.Files)}, nil
}

func (value *source) verifyOutputs(ctx context.Context, options Options, target *destination, intent journal, proof importProof) error {
	for _, item := range []struct {
		name  string
		limit int64
		sha   string
	}{
		{stateName, stateMaxBytes, proof.StateSHA256},
		{originalStateName, stateMaxBytes, intent.SourceStateSHA256},
		{originalManifestName, manifestMaxBytes, intent.ManifestSHA256},
	} {
		digest, _, err := target.managed.Digest(ctx, item.name, item.limit)
		if err != nil || digest != item.sha {
			return ErrUnconfirmed
		}
	}
	available := map[string]sourceFile{}
	for _, entry := range intent.Files {
		if !entry.Unavailable {
			available[entry.ID] = entry
		}
	}
	if len(proof.Files) != len(available) {
		return ErrUnconfirmed
	}
	seen := map[string]bool{}
	for _, entry := range proof.Files {
		original, exists := available[entry.LegacyID]
		if !exists || seen[entry.ID] || !validUUID(entry.ID) || entry.Bytes != original.Bytes || entry.SHA256 != original.SHA256 || !digestPattern.MatchString(entry.MetadataSHA256) {
			return ErrUnconfirmed
		}
		seen[entry.ID] = true
		delete(available, entry.LegacyID)
		name := filepath.Join("attachments", entry.ID)
		digest, size, err := target.managed.Digest(ctx, name+".bin", maxFileBytes)
		if err != nil || digest != entry.SHA256 || size != entry.Bytes {
			return ErrUnconfirmed
		}
		metadata, err := target.managed.ReadFile(ctx, name+".json", files.MaxAttachmentMetadataBytes)
		var attachment contracts.Attachment
		if err != nil || hash(metadata) != entry.MetadataSHA256 || json.Unmarshal(metadata, &attachment) != nil ||
			attachment.ID != entry.ID || attachment.Name != original.Name || attachment.Hash != entry.SHA256 ||
			attachment.GuestPath != filepath.Join(options.TargetDir, name+".bin") {
			return ErrUnconfirmed
		}
	}
	if !target.managed.Unchanged() {
		return ErrChanged
	}
	return ctx.Err()
}
