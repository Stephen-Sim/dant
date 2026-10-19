// Package buildinfo holds immutable values supplied by the pinned build tool.
package buildinfo

import (
	"errors"
	"regexp"

	"github.com/Stephen-Sim/dant/core/internal/updates"
)

// Empty defaults prevent an unversioned service from claiming compatibility.
var Version string
var Source string

var sourcePattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var ErrMetadata = errors.New("build_metadata_unavailable")

func Validate() error {
	if _, err := updates.CompareVersions(Version, Version); err != nil || !sourcePattern.MatchString(Source) {
		return ErrMetadata
	}
	return nil
}
