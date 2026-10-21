package updates

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestReleaseOrderingPreservesNumericAndTextPrereleaseSemantics(t *testing.T) {
	for _, fixture := range []struct {
		left, right string
		want        int
	}{
		{"1.0.0", "1.0.0-beta", 1},
		{"1.0.0-alpha.2", "1.0.0-alpha.11", -1},
		{"1.0.0-alpha.11", "1.0.0-alpha.2", 1},
		{"1.0.0-alpha.1", "1.0.0-alpha", 1},
		{"1.0.0-alpha", "1.0.0-1", 1},
		{"1.0.0-beta", "1.0.0-alpha", 1},
		{"1.0.0-alpha.1", "1.0.0-alpha.1", 0},
	} {
		if order, err := CompareVersions(fixture.left, fixture.right); err != nil || order != fixture.want {
			t.Fatal("prerelease order changed", fixture.left, fixture.right, order, err)
		}
	}
	for _, pair := range [][2]string{{"1.0.0", "invalid"}, {strings.Repeat("1", 65), "1.0.0"}} {
		if _, err := CompareVersions(pair[0], pair[1]); !errors.Is(err, ErrVersion) {
			t.Fatal("invalid version was compared as a valid release", err)
		}
	}
}

func TestInstallationSafetyRequiresConfirmedControllerAndWorkerState(t *testing.T) {
	base := InstallationSnapshot{Mode: "vm-controller", Authority: "vm", ProvisioningStatus: contracts.ProvisioningStatusReady, Worker: contracts.WorkerSnapshot{Queue: []string{}}}
	if !InstallStateSafe(base) {
		t.Fatal("unconfigured idle computer was not safe")
	}
	for _, mutate := range []func(*InstallationSnapshot){
		func(state *InstallationSnapshot) { state.Mode = "worker" },
		func(state *InstallationSnapshot) { state.Authority = "controller" },
		func(state *InstallationSnapshot) { state.ProvisioningRunning = true },
		func(state *InstallationSnapshot) { state.ProvisioningStatus = contracts.ProvisioningStatusCreating },
		func(state *InstallationSnapshot) { state.Worker.Queue = nil },
		func(state *InstallationSnapshot) {
			state.VMConfigured = true
			state.ControllerStatus = contracts.ConnectionStatusOffline
		},
		func(state *InstallationSnapshot) {
			state.VMConfigured = true
			state.ControllerStatus = contracts.ConnectionStatusOnline
			state.Cached = true
		},
	} {
		state := base
		mutate(&state)
		if InstallStateSafe(state) {
			t.Fatal("unconfirmed or busy state admitted installation")
		}
	}
	base.VMConfigured = true
	base.ControllerStatus = contracts.ConnectionStatusOnline
	base.Worker.Messages = []*contracts.ChatMessage{}
	base.Worker.WorkTasks = []contracts.WorkRecord{}
	base.Worker.Worker.Status = contracts.ConnectionStatusOnline
	base.Worker.Extra = contracts.RawObject{"computer": json.RawMessage(`{"status":"dant"}`)}
	if !InstallStateSafe(base) {
		t.Fatal("confirmed online idle worker was not safe")
	}
}

func TestLeaseSnapshotsAndExpirationReleaseExactlyOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		now := time.Now()
		released := 0
		lease := NewInstallLease(LeaseOptions{
			Now: func() time.Time { return now },
			Snapshot: func() InstallationSnapshot {
				return InstallationSnapshot{Mode: "vm-controller", Authority: "vm", ProvisioningStatus: contracts.ProvisioningStatusIdle, Worker: contracts.WorkerSnapshot{Queue: []string{}}}
			},
			Refresh:   func(context.Context) error { return nil },
			OnRelease: func() { released++ },
		})
		defer lease.Close()
		if err := lease.AssertQuiescent(0); err != nil {
			t.Fatal(err)
		}
		receipt, err := lease.Acquire(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		snapshot := lease.Current()
		snapshot.LeaseID = "caller mutation"
		if lease.Current().LeaseID != receipt.LeaseID {
			t.Fatal("caller mutated the active installation lease")
		}
		synctest.Wait()
		now = now.Add(InstallLeaseTTL + time.Second)
		if lease.Current() != nil || released != 1 {
			t.Fatal("observed expiry did not release the installation guard")
		}
		synctest.Wait()
		if lease.Current() != nil || released != 1 {
			t.Fatal("the same lease expired twice")
		}
		lease.Close()
		lease.Close()
	})
	var deferred *Error = updateError("UPDATE_UNAVAILABLE")
	if deferred.Error() != "UPDATE_UNAVAILABLE" {
		t.Fatal("public update error exposed transport details")
	}
}
