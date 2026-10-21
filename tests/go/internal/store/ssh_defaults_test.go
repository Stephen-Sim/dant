package store

import (
	"context"
	"testing"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestSSHDefaultOnlyAppliesBeforeAnExplicitConnectionIsSaved(t *testing.T) {
	value, directory := openFixture(t)
	if value.Snapshot().Settings.VM.Port != 22 {
		t.Fatal("fresh state lost the standard SSH default")
	}
	if err := value.Mutate(context.Background(), func(state *contracts.State) error {
		state.Settings.VM.Port = 2222
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	value.Close()

	reopened, err := OpenContext(context.Background(), directory, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Snapshot().Settings.VM.Port != 2222 {
		t.Fatal("reopen replaced the saved custom SSH port")
	}
}
