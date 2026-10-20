package voice

import "time"

// Both providers use the same media lifecycle and reference-context budgets.
// Their accepted timeout ranges remain provider-specific.
const (
	defaultConnectTimeout   = 15 * time.Second
	defaultMediaStopTimeout = 10 * time.Second
	defaultContextTimeout   = 5 * time.Second
)
