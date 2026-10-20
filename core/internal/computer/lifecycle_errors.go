package computer

// LifecycleReason is an operational category, never helper output or a path.
type LifecycleReason string

const (
	LifecycleReasonBusy            LifecycleReason = "busy"
	LifecycleReasonInvalidIdentity LifecycleReason = "invalid_identity"
	LifecycleReasonInvalidReceipt  LifecycleReason = "invalid_receipt"
	LifecycleReasonInvalidTimeout  LifecycleReason = "invalid_timeout"
	LifecycleReasonBindingChanged  LifecycleReason = "binding_changed"
	LifecycleReasonIntentChanged   LifecycleReason = "intent_changed"
	LifecycleReasonUnconfirmed     LifecycleReason = "unconfirmed"
	LifecycleReasonUnsupported     LifecycleReason = "unsupported"
)

func (reason LifecycleReason) Valid() bool {
	switch reason {
	case LifecycleReasonBusy, LifecycleReasonInvalidIdentity, LifecycleReasonInvalidReceipt,
		LifecycleReasonInvalidTimeout, LifecycleReasonBindingChanged, LifecycleReasonIntentChanged,
		LifecycleReasonUnconfirmed, LifecycleReasonUnsupported:
		return true
	default:
		return false
	}
}

type LifecycleError struct{ Reason LifecycleReason }

func (err *LifecycleError) Code() string {
	reason := err.Reason
	if !reason.Valid() {
		reason = LifecycleReasonUnconfirmed
	}
	return "vm_lifecycle_" + string(reason)
}

func (err *LifecycleError) Error() string {
	return err.Code()
}

func lifecycleFailure(reason LifecycleReason) error {
	return &LifecycleError{Reason: reason}
}
