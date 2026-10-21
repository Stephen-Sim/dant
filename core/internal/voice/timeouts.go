package voice

import "time"

// Both providers use the same media lifecycle and reference-context budgets.
// Their accepted timeout ranges remain provider-specific.
const (
	defaultConnectTimeout    = 15 * time.Second
	defaultMediaStopTimeout  = 10 * time.Second
	defaultContextTimeout    = 5 * time.Second
	defaultAPIRequestTimeout = 30 * time.Second

	minimumProviderTimeout = time.Millisecond
	maximumAPITimeout      = 5 * time.Minute
	maximumNativeTimeout   = time.Minute
)
