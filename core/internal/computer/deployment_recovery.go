package computer

// PendingDeploymentError distinguishes an existing upgrade fence from an
// installer dispatch whose outcome has just become unknown. A compatible,
// independently observed Worker may still serve an explicit reconnect.
type PendingDeploymentError struct {
	BindingDigest string
	Version       string
	Source        string
}

func (err *PendingDeploymentError) Error() string {
	return ErrDeploymentUnconfirmed.Error()
}

func (err *PendingDeploymentError) Unwrap() error {
	return ErrDeploymentUnconfirmed
}

func pendingDeployment(binding Binding, remote deployedSource) error {
	if !remote.Active || remote.SHA256 == nil || remote.Version == nil ||
		remote.Session == nil || *remote.Version != remote.Session.Version {
		return ErrDeploymentUnconfirmed
	}
	return &PendingDeploymentError{
		BindingDigest: BindingDigest(binding),
		Version:       remote.Session.Version,
		Source:        remote.Session.Source,
	}
}
