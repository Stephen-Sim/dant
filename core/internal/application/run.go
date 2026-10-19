// Package application owns process roles and shutdown. Features remain behind
// the Controller and Worker composition roots.
package application

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/user"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/app"
	"github.com/Stephen-Sim/dant/core/internal/backups"
	"github.com/Stephen-Sim/dant/core/internal/buildinfo"
	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/controller"
	"github.com/Stephen-Sim/dant/core/internal/platform"
	"github.com/Stephen-Sim/dant/core/internal/security"
	"github.com/Stephen-Sim/dant/core/internal/shadow"
)

const (
	shutdownTimeout = 20 * time.Second
	headerTimeout   = 10 * time.Second
	idleTimeout     = time.Minute
	maxHeaderBytes  = 64 * 1024
)

type service interface {
	Handler() http.Handler
	Start()
	Close()
}

type workerDeployer interface {
	DeployWorker(context.Context) error
}

type serviceFactory func(context.Context, config.Startup, string) (service, error)

// Child roles use their own fixed argument parser and never construct a live
// Controller or Engine as a side effect.
func Run(ctx context.Context, args []string, input io.Reader, output io.Writer) error {
	if len(args) > 0 && args[0] == "--role=memory-shadow" {
		return shadow.Run(ctx, args, input, output)
	}
	if err := buildinfo.Validate(); err != nil {
		return err
	}

	if len(args) > 0 {
		switch args[0] {
		case "--role=backup-transform":
			if len(args) != 1 {
				return config.ErrStartup
			}
			return backups.RunTransform(ctx, input, output)
		case "--role=backup-cli":
			home, err := os.UserHomeDir()
			if err != nil {
				return config.ErrStartup
			}

			return backups.RunCLI(ctx, args[1:], input, output, backups.CLIOptions{
				AppVersion: buildinfo.Version,
				Home:       home,
			})
		}
	}

	working, err := os.Getwd()
	if err != nil {
		return config.ErrStartup
	}
	executable, err := os.Executable()
	if err != nil {
		return config.ErrStartup
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return config.ErrStartup
	}
	hostname, err := os.Hostname()
	if err != nil {
		return config.ErrStartup
	}
	account, err := user.Current()
	if err != nil {
		return config.ErrStartup
	}
	startup, err := config.LoadStartup(config.StartupInput{
		Arguments:        args,
		Environment:      os.Environ(),
		WorkingDirectory: working,
		Executable:       executable,
		Home:             home,
		Hostname:         hostname,
		Username:         account.Username,
	})
	if err != nil {
		return err
	}
	if startup.Role == config.RolePrepareWorker {
		return prepareWorker(ctx, startup)
	}

	return runService(ctx, startup, executable, input, output, assembleService)
}

func assembleService(ctx context.Context, startup config.Startup, executable string) (service, error) {
	if startup.Role == config.RoleWorker {
		root, err := checkWorkerActivation(ctx, startup, buildinfo.Version, buildinfo.Source)
		if err != nil {
			return nil, err
		}
		startup.Root = root

		return app.NewWorker(ctx, app.WorkerOptions{
			Startup: startup,
			Version: buildinfo.Version,
			Source:  buildinfo.Source,
		})
	}

	if startup.Role == config.RoleController {
		// An unavailable OS zone must not replace the Worker's saved preference
		// with a guessed offset or block an otherwise valid Controller startup.
		zone, _ := platform.HostTimeZone(startup.Environment)

		return controller.New(ctx, controller.Options{
			Root:        startup.Root,
			DataDir:     startup.DataDir,
			Version:     buildinfo.Version,
			BuildSource: buildinfo.Source,
			TimeZone:    zone,
			Network:     startup.Network,
			Environment: startup.Environment,
			Protector:   security.NativeProtector(),
			PrepareOnly: startup.PrepareOnly,
			Executable:  executable,
		})
	}

	return nil, config.ErrStartup
}

// Reserve the public endpoint before constructors can open data stores or start
// their owned maintenance writers. A second process must not mutate shared data
// and only then discover that the first process already owns its API endpoint.
func runService(ctx context.Context, startup config.Startup, executable string, input io.Reader, output io.Writer, construct serviceFactory) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	address := net.JoinHostPort(startup.Listen.Host, fmt.Sprint(startup.Listen.Port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	defer listener.Close()

	if err := ctx.Err(); err != nil {
		return err
	}

	instance, err := construct(ctx, startup, executable)
	if err != nil {
		return err
	}
	defer instance.Close()

	if startup.DeployWorker {
		deployer, ok := instance.(workerDeployer)
		if !ok || startup.Role != config.RoleController {
			return config.ErrStartup
		}

		return deployer.DeployWorker(ctx)
	}

	return serve(ctx, instance, listener, output, startup.ManagedInput, input)
}

func serve(ctx context.Context, instance service, listener net.Listener, output io.Writer, managed bool, input io.Reader) error {
	owner, cancel := context.WithCancel(ctx)
	defer cancel()
	server := &http.Server{
		Handler:           instance.Handler(),
		ReadHeaderTimeout: headerTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		BaseContext:       func(net.Listener) context.Context { return owner },
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()

	if _, err := fmt.Fprintf(output, "dant listening at http://%s\n", listener.Addr().String()); err != nil {
		instance.Close()
		_ = server.Close()
		<-done
		return err
	}

	instance.Start()
	var managedDone <-chan struct{}
	if managed {
		finished := make(chan struct{})
		managedDone = finished
		go func() {
			_, _ = io.Copy(io.Discard, input)
			close(finished)
		}()
	}

	var result error
	select {
	case <-owner.Done():
	case <-managedDone:
	case result = <-done:
		done = nil
	}

	cancel()
	instance.Close()

	closing, stop := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer stop()
	if err := server.Shutdown(closing); err != nil {
		_ = server.Close()
	}
	if done != nil {
		<-done
	}
	if managed {
		if closer, ok := input.(io.Closer); ok {
			_ = closer.Close()
		}
		<-managedDone
	}
	if errors.Is(result, http.ErrServerClosed) {
		return nil
	}
	return result
}
