package runtime

import "sync/atomic"

type transmissionPhase uint32

const (
	transmissionQueued transmissionPhase = iota
	transmissionStarted
	transmissionAbandoned
)

// A queued frame can either start once or be abandoned before any write. The
// atomic transition prevents cancellation from reporting an unsent result while
// the writer subsequently sends the same frame after a slow ownership guard.
type rpcTransmission struct {
	phase atomic.Uint32
}

func (transmission *rpcTransmission) begin() bool {
	return transmission.phase.CompareAndSwap(uint32(transmissionQueued), uint32(transmissionStarted))
}

// abandon seals a frame that has not started and reports whether its outcome
// is uncertain. Once a physical write may have begun, cancellation cannot make
// that operation safe to replay.
func (transmission *rpcTransmission) abandon() bool {
	transmission.phase.CompareAndSwap(uint32(transmissionQueued), uint32(transmissionAbandoned))
	return transmission.phase.Load() == uint32(transmissionStarted)
}
