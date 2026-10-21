package computer

import (
	"errors"
	"strings"
	"testing"
)

func TestPendingDeploymentRecoveryRequiresObservedExistingCompatibleWorker(t *testing.T) {
	fingerprint, version := strings.Repeat("b", 64), "0.4.7-beta.23"
	binding := Binding{Host: "fixture.invalid", User: "fixture", Port: 22}
	remote := deployedSource{
		SHA256:  &fingerprint,
		Active:  true,
		Version: &version,
		Session: &deployedWorkerSession{
			Product:  "dant",
			Mode:     "worker",
			Runtime:  "go",
			Protocol: 1,
			Version:  version,
			Source:   strings.Repeat("c", 40),
		},
	}
	err := pendingDeployment(binding, remote)
	var pending *PendingDeploymentError
	if !errors.Is(err, ErrDeploymentUnconfirmed) || !errors.As(err, &pending) ||
		pending.BindingDigest != BindingDigest(binding) || pending.Version != version ||
		pending.Source != remote.Session.Source {
		t.Fatal("an existing compatible Worker lost its classified identity")
	}
	for _, change := range []func(*deployedSource){
		func(value *deployedSource) { value.Active = false },
		func(value *deployedSource) { value.SHA256 = nil },
		func(value *deployedSource) { value.Version = nil },
		func(value *deployedSource) { value.Session = nil },
		func(value *deployedSource) {
			other := "0.4.7-beta.22"
			value.Version = &other
		},
	} {
		value := remote
		change(&value)
		pending = nil
		if err := pendingDeployment(binding, value); !errors.Is(err, ErrDeploymentUnconfirmed) ||
			errors.As(err, &pending) {
			t.Fatal("an unconfirmed Worker authorized connection recovery")
		}
	}
}
