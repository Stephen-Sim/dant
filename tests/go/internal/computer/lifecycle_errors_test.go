package computer

import (
	"strings"
	"testing"
)

func TestLifecycleErrorCannotExposeAnUnknownReason(t *testing.T) {
	for _, reason := range []LifecycleReason{
		"", "synthetic-private-token", "private-host.invalid/path", "Bearer credential",
	} {
		err := &LifecycleError{Reason: reason}
		if reason.Valid() || err.Code() != "vm_lifecycle_unconfirmed" || strings.Contains(err.Error(), string(reason)) && reason != "" {
			t.Fatal("unknown helper metadata was treated as a public lifecycle reason")
		}
	}
}
