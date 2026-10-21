package updates

import (
	"errors"
	"math/big"
	"regexp"
	"strings"
)

var ErrVersion = errors.New("UPDATE_INVALID_RELEASE")
var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][A-Za-z0-9-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][A-Za-z0-9-]*))*))?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$`)
var numericIdentifier = regexp.MustCompile(`^[0-9]+$`)

type version struct {
	parts      [3]*big.Int
	prerelease []string
}

func parseVersion(value string) (version, error) {
	if len(value) > 64 {
		return version{}, ErrVersion
	}
	match := versionPattern.FindStringSubmatch(value)
	if match == nil {
		return version{}, ErrVersion
	}
	var result version
	for index := range result.parts {
		result.parts[index], _ = new(big.Int).SetString(match[index+1], 10)
	}

	if match[4] != "" {
		result.prerelease = strings.Split(match[4], ".")
	}

	return result, nil
}

func CompareVersions(left, right string) (int, error) {
	a, err := parseVersion(left)
	if err != nil {
		return 0, err
	}
	b, err := parseVersion(right)
	if err != nil {
		return 0, err
	}
	for index := range a.parts {
		if result := a.parts[index].Cmp(b.parts[index]); result != 0 {
			return result, nil
		}
	}

	if len(a.prerelease) == 0 || len(b.prerelease) == 0 {
		if len(a.prerelease) == len(b.prerelease) {
			return 0, nil
		}
		if len(a.prerelease) == 0 {
			return 1, nil
		}
		return -1, nil
	}
	for index := 0; index < len(a.prerelease) || index < len(b.prerelease); index++ {
		if index >= len(a.prerelease) {
			return -1, nil
		}
		if index >= len(b.prerelease) {
			return 1, nil
		}
		x, y := a.prerelease[index], b.prerelease[index]
		if x == y {
			continue
		}
		numericX, numericY := numericIdentifier.MatchString(x), numericIdentifier.MatchString(y)
		if numericX && numericY {
			first, _ := new(big.Int).SetString(x, 10)
			second, _ := new(big.Int).SetString(y, 10)
			return first.Cmp(second), nil
		}
		if numericX != numericY {
			if numericX {
				return -1, nil
			}
			return 1, nil
		}
		return strings.Compare(x, y), nil
	}

	return 0, nil
}
