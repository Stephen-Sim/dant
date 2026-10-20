package computer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
)

func TestDeploymentBudgetCoversSequentialBackupAndOfflinePreparation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		root, manifest, fingerprint := deploymentBundleFixture(t)
		_, directory := ownedLifecycleFixture(t, nil)
		binding, _ := ReadBinding(directory)
		network, _ := config.ReadNetwork(nil)
		uploads := 0
		installed := false
		deployer, err := NewDeployer(DeploymentOptions{
			Context: context.Background(), ProjectRoot: root, DataDir: directory,
			Version: manifest.Version, BuildSource: manifest.SourceCommit, Network: network,
			Binding:   func() (Binding, error) { return binding, nil },
			Quiescent: func(context.Context) error { return nil },
			Run: func(ctx context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
				if input != nil {
					uploads++
					if _, err := io.Copy(io.Discard, input); err != nil {
						return nil, err
					}
					for range 2 {
						timer := time.NewTimer(12 * time.Minute)
						select {
						case <-timer.C:
						case <-ctx.Done():
							timer.Stop()
							return nil, ctx.Err()
						}
					}
					installed = true
					return nil, nil
				}
				sha := strings.Repeat("b", 64)
				var session *deployedWorkerSession
				if installed {
					sha = fingerprint
					session = deploymentSessionFixture(manifest)
				}
				return json.Marshal(deployedSource{SHA256: &sha, Active: true, Version: &manifest.Version, Session: session})
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		if err := deployer.Prepare(context.Background(), binding); err != nil {
			t.Fatal("sequential remote stages were truncated by a single-stage deadline", err)
		}
		if time.Since(started) != 24*time.Minute || uploads != 1 || !deployer.Status().Confirmed {
			t.Fatal("deployment did not retain one attempt and exact live-source confirmation")
		}
	})
}

func TestCancelledOrExpiredDeploymentStaysUnknownAndCannotReplay(t *testing.T) {
	for _, mode := range []string{"total deadline", "request cancellation", "owner cancellation"} {
		t.Run(mode, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				root, manifest, _ := deploymentBundleFixture(t)
				_, directory := ownedLifecycleFixture(t, nil)
				binding, _ := ReadBinding(directory)
				network, _ := config.ReadNetwork(nil)
				owner, cancelOwner := context.WithCancel(context.Background())
				defer cancelOwner()
				request, cancelRequest := context.WithCancel(context.Background())
				defer cancelRequest()
				entered := make(chan struct{})
				uploads := 0
				options := DeploymentOptions{
					Context: owner, ProjectRoot: root, DataDir: directory,
					Version: manifest.Version, BuildSource: manifest.SourceCommit, Network: network,
					Binding:   func() (Binding, error) { return binding, nil },
					Quiescent: func(context.Context) error { return nil },
					Run: func(ctx context.Context, _ string, _ []string, input io.Reader) ([]byte, error) {
						if input != nil {
							uploads++
							close(entered)
							<-ctx.Done()
							return nil, ctx.Err()
						}
						sha := strings.Repeat("b", 64)
						return json.Marshal(deployedSource{SHA256: &sha, Active: true, Version: &manifest.Version})
					},
				}
				deployer, err := NewDeployer(options)
				if err != nil {
					t.Fatal(err)
				}
				started := time.Now()
				finished := make(chan error, 1)
				go func() {
					finished <- deployer.Prepare(request, binding)
				}()
				<-entered
				switch mode {
				case "request cancellation":
					cancelRequest()
				case "owner cancellation":
					cancelOwner()
				}
				if err := <-finished; !errors.Is(err, ErrDeploymentUnconfirmed) {
					t.Fatal("an interrupted installer lost its explicit unknown outcome", err)
				}
				elapsed := time.Since(started)
				if (mode == "total deadline" && elapsed != DeploymentTimeout) || (mode != "total deadline" && elapsed != 0) {
					t.Fatal("the cutover was not bounded or owner cancellation was delayed")
				}
				status := deployer.Status()
				if status.Status != contracts.ServiceUpdateStatusPending || status.Confirmed || status.Reason == nil || *status.Reason != "update-unconfirmed" {
					t.Fatal("an interrupted installer was displayed as completed or safe to replay")
				}

				options.Context = context.Background()
				restarted, err := NewDeployer(options)
				if err != nil {
					t.Fatal(err)
				}
				if err := restarted.Prepare(context.Background(), binding); !errors.Is(err, ErrDeploymentUnconfirmed) || uploads != 1 {
					t.Fatal("a pending cutover replayed after restart instead of readonly reconciliation", err)
				}
			})
		})
	}
}
