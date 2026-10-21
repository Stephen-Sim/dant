package computer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"path/filepath"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
)

// VerifyBundle authenticates every allowlisted member before offline preparation
// or activation. The caller resolves its managed app symlink deliberately first.
func VerifyBundle(ctx context.Context, root, version, source string) (BundleManifest, []byte, error) {
	if err := ctx.Err(); err != nil {
		return BundleManifest{}, nil, err
	}

	manifest, canonical, err := readBundle(root, version, source)
	if err != nil {
		return BundleManifest{}, nil, err
	}

	raw, err := files.ReadRegular(filepath.Join(root, filepath.FromSlash(BundleManifestPath)), bundleManifestLimit)
	object, decodeErr := contracts.DecodeObject(raw, bundleManifestLimit)
	var entries []json.RawMessage
	if err != nil || decodeErr != nil || json.Unmarshal(object["files"], &entries) != nil {
		return BundleManifest{}, nil, ErrDeploymentUnavailable
	}
	for _, rawEntry := range entries {
		entry, err := contracts.DecodeObject(rawEntry, bundleManifestLimit)
		if err != nil || len(entry) != 3 || entry["path"] == nil || entry["bytes"] == nil || entry["sha256"] == nil {
			return BundleManifest{}, nil, ErrDeploymentUnavailable
		}
	}

	managed, err := files.OpenManagedRoot(root, false)
	if err != nil {
		return BundleManifest{}, nil, ErrDeploymentUnavailable
	}
	defer managed.Close()

	for _, entry := range manifest.Files {
		digest := sha256.New()
		err := managed.WithReader(ctx, entry.Path, entry.Bytes, func(input io.Reader) error {
			count, err := io.Copy(digest, input)
			if err != nil || count != entry.Bytes || hex.EncodeToString(digest.Sum(nil)) != entry.SHA256 {
				return ErrDeploymentUnavailable
			}
			return nil
		})
		if err != nil {
			if ctx.Err() != nil {
				return BundleManifest{}, nil, ctx.Err()
			}
			return BundleManifest{}, nil, ErrDeploymentUnavailable
		}
	}

	// The manifest itself must still describe the bytes we authenticated.
	_, current, err := readBundle(root, version, source)
	if err != nil || string(current) != string(canonical) || !managed.Unchanged() {
		return BundleManifest{}, nil, ErrDeploymentUnavailable
	}
	return manifest, canonical, nil
}
