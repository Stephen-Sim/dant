package application

import (
	"os"
	"os/user"
)

// The process entrypoint captures host observations before shared configuration
// validates them. Features receive the resulting startup values, not OS lookups.
type processHost struct {
	working     func() (string, error)
	executable  func() (string, error)
	home        func() (string, error)
	hostname    func() (string, error)
	account     func() (*user.User, error)
	environment func() []string
}

func newProcessHost() processHost {
	return processHost{
		working:     os.Getwd,
		executable:  os.Executable,
		home:        os.UserHomeDir,
		hostname:    os.Hostname,
		account:     user.Current,
		environment: os.Environ,
	}
}
