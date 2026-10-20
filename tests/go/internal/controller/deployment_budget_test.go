package controller

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/computer"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/updates"
)

type budgetBridgeFixture struct {
	*controllerBridgeFixture
	operation func(context.Context) error
	calls     int
}

func (bridge *budgetBridgeFixture) Prepare(ctx context.Context) error {
	bridge.calls++
	return bridge.operation(ctx)
}

func (bridge *budgetBridgeFixture) Connect(ctx context.Context, deploy bool) error {
	if !deploy {
		return computer.ErrDeploymentUnavailable
	}
	if err := bridge.Prepare(ctx); err != nil {
		return err
	}
	return bridge.controllerBridgeFixture.Connect(ctx, deploy)
}

func automaticBudgetApp(t *testing.T, parent context.Context, online bool) (*App, *budgetBridgeFixture) {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "fixture.key"), []byte("isolated key fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "vm.json"), []byte(`{"host":"fixture.invalid","user":"fixture","keyPath":"fixture.key"}`), 0600); err != nil {
		t.Fatal(err)
	}
	profiles, err := computer.NewProfiles(computer.ProfileOptions{
		DataDir: directory, ProjectRoot: directory,
		RegistryFile: filepath.Join(directory, "profiles.json"), Owner: "isolated-owner",
	})
	if err != nil {
		t.Fatal(err)
	}
	state := emptyWorkerSnapshot()
	state.Settings.Language = "zh"
	status := contracts.ConnectionStatusOffline
	if online {
		status = contracts.ConnectionStatusOnline
	}
	bridge := &budgetBridgeFixture{controllerBridgeFixture: &controllerBridgeFixture{status: status, state: state}}
	owner, cancel := context.WithCancel(parent)
	app := &App{
		ctx: owner, cancel: cancel,
		options:       Options{DataDir: directory},
		configuration: defaultConfiguration(),
		bridge:        bridge,
		profiles:      profiles,
		lifecycle:     &desktopPowerFixture{},
		lease:         updates.NewInstallLease(updates.LeaseOptions{}),
		events:        newEventHub(),
		started:       true,
	}
	if online {
		app.deployer = &computer.Deployer{}
	}
	t.Cleanup(app.Close)
	return app, bridge
}

func TestAutomaticDeploymentOutlivesTheConnectionProbeBudget(t *testing.T) {
	for _, online := range []bool{false, true} {
		name := "connect and deploy"
		if online {
			name = "prepare connected worker"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				app, bridge := automaticBudgetApp(t, context.Background(), online)
				finished := make(chan error, 1)
				var budget time.Duration
				bridge.operation = func(ctx context.Context) error {
					deadline, ok := ctx.Deadline()
					if ok {
						budget = time.Until(deadline)
					}
					timer := time.NewTimer(4 * time.Minute)
					defer timer.Stop()
					var err error
					select {
					case <-timer.C:
					case <-ctx.Done():
						err = ctx.Err()
					}
					app.mu.Lock()
					app.configuration.ServiceUpdatesPaused = true
					app.mu.Unlock()
					finished <- err
					return err
				}
				started := time.Now()
				app.wg.Add(1)
				go app.automatic()
				err := <-finished
				app.Close()

				if err != nil || time.Since(started) != 4*time.Minute || bridge.calls != 1 {
					t.Fatal("a complete deployment was cut off at the connection-only deadline", err)
				}
				if budget < computer.DeploymentTimeout || budget > computer.DeploymentTimeout+3*time.Minute {
					t.Fatal("automatic deployment did not receive the bounded complete-cutover budget")
				}
			})
		})
	}
}

func TestAutomaticDeploymentStillJoinsOnCloseAndParentCancellation(t *testing.T) {
	for _, parentCancelled := range []bool{false, true} {
		name := "application close"
		if parentCancelled {
			name = "parent cancellation"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				parent, cancel := context.WithCancel(context.Background())
				defer cancel()
				app, bridge := automaticBudgetApp(t, parent, true)
				entered := make(chan struct{})
				finished := make(chan error, 1)
				bridge.operation = func(ctx context.Context) error {
					close(entered)
					<-ctx.Done()
					finished <- ctx.Err()
					return ctx.Err()
				}
				app.wg.Add(1)
				go app.automatic()
				<-entered
				started := time.Now()
				if parentCancelled {
					cancel()
				}
				app.Close()

				if err := <-finished; !errors.Is(err, context.Canceled) || time.Since(started) != 0 || bridge.calls != 1 {
					t.Fatal("the larger deployment budget delayed owner cancellation or replayed work", err)
				}
			})
		})
	}
}
