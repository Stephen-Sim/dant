package computer

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Stephen-Sim/dant/core/internal/config"
	"github.com/Stephen-Sim/dant/core/internal/contracts"
	"github.com/Stephen-Sim/dant/core/internal/files"
	"github.com/Stephen-Sim/dant/core/internal/platform"
	"github.com/Stephen-Sim/dant/core/internal/security"
)

const BundleManifestPath = "resources/core/bundle-manifest.json"
const GuestBinaryPath = "resources/core/dant-core-linux-amd64"
const bundleManifestLimit = 64 * 1024
const bundleFileLimit = int64(512 * 1024 * 1024)
const bundleTotalLimit = int64(1024 * 1024 * 1024)

// DeploymentTimeout bounds the whole upload and cutover, including the remote
// backup and offline preparation stages. Each stage keeps its own tighter guard.
const DeploymentTimeout = 45 * time.Minute
const deploymentInspectTimeout = 10 * time.Second

var ErrDeploymentUnavailable = errors.New("vm_bundle_unavailable")
var ErrDeploymentUnconfirmed = errors.New("vm_update_unconfirmed")
var ErrDeploymentDeferred = errors.New("vm_update_deferred")
var sourceCommitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var bundleHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var bundleAllowlist = map[string]bool{
	GuestBinaryPath:                     true,
	"vm/bootstrap.sh":                   true,
	"vm/control.py":                     true,
	"vm/desktop_mcp.py":                 true,
	"vm/desktop.py":                     true,
	"vm/guest.py":                       true,
	"vm/install-speech.sh":              true,
	"vm/install-transcription.sh":       true,
	"vm/install-worker.sh":              true,
	"vm/worker-install.py":              true,
	"vm/start-codex.sh":                 true,
	"vm/transcribe_audio.py":            true,
	"vm/transcription-requirements.txt": true,
	"vm/voice_message.py":               true,
	"src/config/protocol.json":          true,
}

type BundleFile struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type BundleManifest struct {
	SchemaVersion int          `json:"schemaVersion"`
	Version       string       `json:"version"`
	SourceCommit  string       `json:"sourceCommit"`
	Files         []BundleFile `json:"files"`
}

type DeploymentStatus struct {
	Status         contracts.ServiceUpdateStatus `json:"status"`
	TargetVersion  string                        `json:"targetVersion"`
	RunningVersion *string                       `json:"runningVersion"`
	Confirmed      bool                          `json:"confirmed"`
	Reason         *string                       `json:"reason"`
}

type DeploymentOptions struct {
	Context                                    context.Context
	ProjectRoot, DataDir, Version, BuildSource string
	Network                                    config.Network
	Run                                        func(context.Context, string, []string, io.Reader) ([]byte, error)
	Binding                                    func() (Binding, error)
	Quiescent                                  func(context.Context) error
	Changed                                    func()
}

type Deployer struct {
	mu        sync.Mutex
	operation sync.Mutex
	options   DeploymentOptions
	status    DeploymentStatus
	desired   string
}

type updateAttempt struct {
	Binding string `json:"binding"`
	Source  string `json:"source"`
}

type updateAttempts struct {
	SchemaVersion int             `json:"schemaVersion"`
	Entries       []updateAttempt `json:"entries"`
}

func NewDeployer(options DeploymentOptions) (*Deployer, error) {
	if options.Context == nil || !filepath.IsAbs(options.ProjectRoot) || !filepath.IsAbs(options.DataDir) || options.Version == "" {
		return nil, ErrDeploymentUnavailable
	}

	if options.Run == nil {
		options.Run = func(ctx context.Context, executable string, args []string, input io.Reader) ([]byte, error) {
			return platform.RunLimited(ctx, executable, args, input, vmStateMaxBytes)
		}
	}

	if options.Binding == nil {
		options.Binding = func() (Binding, error) { return ReadBinding(options.DataDir) }
	}

	if options.Changed == nil {
		options.Changed = func() {}
	}

	return &Deployer{options: options, status: DeploymentStatus{Status: contracts.ServiceUpdateStatusPending, TargetVersion: options.Version}}, nil
}

func (deployer *Deployer) Status() DeploymentStatus {
	deployer.mu.Lock()
	defer deployer.mu.Unlock()
	result := deployer.status
	if result.RunningVersion != nil {
		value := *result.RunningVersion
		result.RunningVersion = &value
	}

	if result.Reason != nil {
		value := *result.Reason
		result.Reason = &value
	}

	return result
}

func (deployer *Deployer) set(status contracts.ServiceUpdateStatus, reason string, confirmed bool) {
	deployer.mu.Lock()
	deployer.status.Status = status
	deployer.status.Confirmed = confirmed
	deployer.status.Reason = nil
	if reason != "" {
		deployer.status.Reason = &reason
	}

	if confirmed {
		version := deployer.options.Version
		deployer.status.RunningVersion = &version
	}
	deployer.mu.Unlock()
	deployer.options.Changed()
}

func readBundle(root, version, source string) (BundleManifest, []byte, error) {
	raw, err := files.ReadRegular(filepath.Join(root, filepath.FromSlash(BundleManifestPath)), bundleManifestLimit)
	if err != nil {
		return BundleManifest{}, nil, ErrDeploymentUnavailable
	}
	object, err := contracts.DecodeObject(raw, bundleManifestLimit)
	if err != nil || len(object) != 4 {
		return BundleManifest{}, nil, ErrDeploymentUnavailable
	}
	var manifest BundleManifest
	if json.Unmarshal(raw, &manifest) != nil || manifest.SchemaVersion != 1 || manifest.Version != version || !sourceCommitPattern.MatchString(manifest.SourceCommit) || (source != "" && manifest.SourceCommit != source) || len(manifest.Files) == 0 || len(manifest.Files) > len(bundleAllowlist) {
		return BundleManifest{}, nil, ErrDeploymentUnavailable
	}
	seen := map[string]bool{}
	total := int64(0)
	for _, file := range manifest.Files {
		if !bundleAllowlist[file.Path] || seen[file.Path] || file.Bytes <= 0 || file.Bytes > bundleFileLimit || !bundleHashPattern.MatchString(file.SHA256) {
			return BundleManifest{}, nil, ErrDeploymentUnavailable
		}
		seen[file.Path] = true
		total += file.Bytes
		if total > bundleTotalLimit {
			return BundleManifest{}, nil, ErrDeploymentUnavailable
		}
	}
	for _, required := range []string{
		GuestBinaryPath,
		"vm/install-worker.sh",
		"vm/worker-install.py",
		"vm/guest.py",
		"vm/control.py",
		"vm/desktop.py",
		"vm/desktop_mcp.py",
		"vm/start-codex.sh",
		"vm/transcribe_audio.py",
		"vm/voice_message.py",
		"src/config/protocol.json",
	} {
		if !seen[required] {
			return BundleManifest{}, nil, ErrDeploymentUnavailable
		}
	}
	sort.Slice(manifest.Files, func(i, j int) bool { return manifest.Files[i].Path < manifest.Files[j].Path })
	normalized, _ := json.Marshal(manifest)
	return manifest, normalized, nil
}

func (deployer *Deployer) attempts(binding Binding, source, action string) (bool, error) {
	name := filepath.Join(deployer.options.DataDir, "vm-update-attempts.json")
	value := updateAttempts{SchemaVersion: 1, Entries: []updateAttempt{}}
	raw, err := files.ReadRegular(name, pauseReceiptByteLimit)
	if err == nil {
		if _, err := contracts.DecodeObject(raw, pauseReceiptByteLimit); err != nil {
			return false, ErrDeploymentUnconfirmed
		}
		if json.Unmarshal(raw, &value) != nil || value.SchemaVersion != 1 || len(value.Entries) > pauseReceiptEntryLimit || value.Entries == nil {
			return false, ErrDeploymentUnconfirmed
		}
		for _, entry := range value.Entries {
			if !bundleHashPattern.MatchString(entry.Binding) || !bundleHashPattern.MatchString(entry.Source) {
				return false, ErrDeploymentUnconfirmed
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, ErrDeploymentUnconfirmed
	}
	key := BindingDigest(binding)
	found := false
	entries := []updateAttempt{}
	for _, entry := range value.Entries {
		if entry.Binding == key {
			found = true
			if action == "clear" {
				continue
			}
		}
		entries = append(entries, entry)
	}

	if action == "read" {
		return found, nil
	}

	if action == "start" {
		if found || len(entries) >= pauseReceiptEntryLimit || !bundleHashPattern.MatchString(source) {
			return false, ErrDeploymentUnconfirmed
		}
		entries = append(entries, updateAttempt{key, source})
	}
	value.Entries = entries
	raw, _ = json.Marshal(value)
	if err := files.WriteAtomic(deployer.options.Context, name, raw, 0600); err != nil {
		return false, ErrDeploymentUnconfirmed
	}

	return found, nil
}

type deployedSource struct {
	SHA256  *string                `json:"sha256"`
	Active  bool                   `json:"active"`
	Version *string                `json:"version"`
	Session *deployedWorkerSession `json:"session"`
}

type deployedWorkerSession struct {
	Product  string `json:"product"`
	Mode     string `json:"mode"`
	Runtime  string `json:"runtime"`
	Protocol int    `json:"protocol"`
	Version  string `json:"version"`
	Source   string `json:"source"`
}

func (remote deployedSource) matches(manifest BundleManifest, fingerprint string) bool {
	session := remote.Session
	return remote.Active && remote.SHA256 != nil && *remote.SHA256 == fingerprint &&
		remote.Version != nil && *remote.Version == manifest.Version && session != nil &&
		session.Product == "dant" && session.Mode == "worker" &&
		session.Runtime == security.CoreRuntime && session.Protocol == security.CoreProtocolVersion &&
		session.Version == manifest.Version && session.Source == manifest.SourceCommit
}

const inspectDeployment = `python3 - <<'PY'
import json,pathlib,subprocess,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,request,response,code,message,headers,url): return None
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
p=pathlib.Path.home()/'dant/deployed-source.json'
sha=None
try:
 data=p.read_bytes()
 if len(data)<=4096:
  value=json.loads(data).get('sha256')
  if isinstance(value,str) and len(value)==64 and all(c in '0123456789abcdef' for c in value): sha=value
except (OSError,ValueError,AttributeError): pass
units=('dant-worker.service','dant-guest-local.service')
active=all(subprocess.run(['systemctl','--user','is-active','--quiet',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=2).returncode==0 for unit in units)
version=None
build=None
if active:
 try:
  def read(path,token=None):
   request=urllib.request.Request('http://127.0.0.1:4317'+path,headers={} if token is None else {'X-Dant-Token':token})
   with opener.open(request,timeout=2) as response:
    raw=response.read(4097)
    if len(raw)>4096: raise ValueError()
    return json.loads(raw)
  session=read('/api/session')
  if session.get('product')!='dant' or session.get('mode')!='worker': raise ValueError()
  if any(key in session for key in ('runtime','protocol','source')):
   build={key:session.get(key) for key in ('product','mode','runtime','protocol','version','source')}
  token=session.get('token')
  if not isinstance(token,str) or not 32<=len(token)<=512 or any(c not in '0123456789abcdefABCDEF' for c in token): raise ValueError()
  candidate=read('/api/version',token).get('version')
  if isinstance(candidate,str) and 0<len(candidate)<=64: version=candidate
 except (OSError,ValueError,AttributeError): pass
print(json.dumps({'sha256':sha,'active':active,'version':version,'session':build}))
PY`

func (deployer *Deployer) remote(ctx context.Context, binding Binding) (deployedSource, error) {
	bounded, stop := context.WithTimeout(ctx, deploymentInspectTimeout)
	defer stop()
	raw, err := deployer.options.Run(bounded, "ssh", append(SSHArgs(binding), binding.User+"@"+binding.Host, inspectDeployment), nil)
	if err != nil || len(raw) > 4096 {
		return deployedSource{}, ErrDeploymentUnavailable
	}
	object, err := contracts.DecodeObject(raw, 4096)
	var result deployedSource
	if err != nil || len(object) != 4 || json.Unmarshal(raw, &result) != nil ||
		(result.SHA256 != nil && !bundleHashPattern.MatchString(*result.SHA256)) ||
		(result.Version != nil && (len(*result.Version) == 0 || len(*result.Version) > 64)) {
		return deployedSource{}, ErrDeploymentUnconfirmed
	}
	for _, name := range []string{"sha256", "active", "version", "session"} {
		if _, exists := object[name]; !exists {
			return deployedSource{}, ErrDeploymentUnconfirmed
		}
	}
	if string(object["active"]) != "true" && string(object["active"]) != "false" {
		return deployedSource{}, ErrDeploymentUnconfirmed
	}
	if session := result.Session; session != nil {
		if session.Product != "dant" || session.Mode != "worker" ||
			session.Runtime != security.CoreRuntime || session.Protocol != security.CoreProtocolVersion ||
			session.Version == "" || len(session.Version) > 64 || !sourceCommitPattern.MatchString(session.Source) {
			return deployedSource{}, ErrDeploymentUnconfirmed
		}
	}

	return result, nil
}

const inspectWorkerQuiescence = `python3 - <<'PY'
import json,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,request,response,code,message,headers,url): return None
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
base='http://127.0.0.1:4317'
def read(path,token=None):
 request=urllib.request.Request(base+path,headers={} if token is None else {'X-Dant-Token':token})
 with opener.open(request,timeout=5) as response:
  raw=response.read(8388609)
  if len(raw)>8388608: raise ValueError()
  return json.loads(raw)
session=read('/api/session')
if session.get('product')!='dant' or session.get('mode')!='worker': raise ValueError()
token=session.get('token')
if not isinstance(token,str) or not 32<=len(token)<=512: raise ValueError()
print(json.dumps(read('/api/state',token),separators=(',',':')))
PY`

func (deployer *Deployer) remoteQuiescent(ctx context.Context, binding Binding) error {
	bounded, stop := context.WithTimeout(ctx, deploymentInspectTimeout)
	defer stop()
	raw, err := deployer.options.Run(bounded, "ssh", append(SSHArgs(binding), binding.User+"@"+binding.Host, inspectWorkerQuiescence), nil)
	if err != nil || len(raw) > vmStateMaxBytes {
		return ErrDeploymentDeferred
	}

	if _, err := contracts.DecodeObject(raw, vmStateMaxBytes); err != nil {
		return ErrDeploymentDeferred
	}
	var state contracts.WorkerSnapshot
	if json.Unmarshal(raw, &state) != nil || !ServiceUpdateQuiescent(state, true) {
		return ErrDeploymentDeferred
	}

	return nil
}

func (deployer *Deployer) Prepare(ctx context.Context, binding Binding) error {
	if !deployer.operation.TryLock() {
		return ErrBridgeBusy
	}
	defer deployer.operation.Unlock()
	bounded, stop := context.WithTimeout(ctx, DeploymentTimeout)
	stopOwner := context.AfterFunc(deployer.options.Context, stop)
	defer func() {
		stopOwner()
		stop()
	}()
	current := func() error {
		if err := bounded.Err(); err != nil {
			return err
		}
		latest, err := deployer.options.Binding()
		if err != nil || latest != binding {
			return ErrBridgeChanged
		}
		return nil
	}

	if err := current(); err != nil {
		return err
	}
	manifest, raw, err := readBundle(deployer.options.ProjectRoot, deployer.options.Version, deployer.options.BuildSource)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	fingerprint := hex.EncodeToString(sum[:])
	deployer.mu.Lock()
	deployer.desired = fingerprint
	deployer.mu.Unlock()
	deployer.set(contracts.ServiceUpdateStatusChecking, "", false)
	remote, err := deployer.remote(bounded, binding)
	if err != nil {
		return err
	}

	if err := current(); err != nil {
		return err
	}
	pending, err := deployer.attempts(binding, fingerprint, "read")
	if err != nil {
		return err
	}

	if remote.matches(manifest, fingerprint) {
		if pending {
			if _, err := deployer.attempts(binding, fingerprint, "clear"); err != nil {
				return err
			}
		}
		deployer.set(contracts.ServiceUpdateStatusCurrent, "", true)
		return nil
	}

	if pending {
		deployer.set(contracts.ServiceUpdateStatusPending, "update-unconfirmed", false)
		return ErrDeploymentUnconfirmed
	}

	if deployer.options.Quiescent != nil {
		if err := deployer.options.Quiescent(bounded); err != nil {
			deployer.set(contracts.ServiceUpdateStatusPending, "work-active", false)
			return ErrDeploymentDeferred
		}
	} else if remote.Active {
		if err := deployer.remoteQuiescent(bounded, binding); err != nil {
			deployer.set(contracts.ServiceUpdateStatusPending, "work-active", false)
			return err
		}
	}
	directory, err := os.MkdirTemp(deployer.options.DataDir, "deploy-")
	if err != nil {
		return ErrDeploymentUnavailable
	}
	_ = os.Chmod(directory, 0700)
	identity, err := os.Lstat(directory)
	if err != nil {
		return ErrDeploymentUnavailable
	}
	defer func() {
		if info, err := os.Lstat(directory); err == nil && info.IsDir() && os.SameFile(identity, info) && filepath.Dir(directory) == deployer.options.DataDir && strings.HasPrefix(filepath.Base(directory), "deploy-") {
			_ = os.RemoveAll(directory)
		}
	}()
	archive := filepath.Join(directory, "source.tar")
	if err := writeBundleTar(bounded, deployer.options.ProjectRoot, archive, manifest, raw, fingerprint, deployer.options.Network); err != nil {
		return err
	}

	if err := current(); err != nil {
		return err
	}
	_, recheck, err := readBundle(deployer.options.ProjectRoot, deployer.options.Version, deployer.options.BuildSource)
	if err != nil || string(raw) != string(recheck) {
		return ErrDeploymentUnavailable
	}

	if _, err := deployer.attempts(binding, fingerprint, "start"); err != nil {
		return err
	}
	deployer.set(contracts.ServiceUpdateStatusUpdating, "", false)
	input, err := os.Open(archive)
	if err != nil {
		return ErrDeploymentUnconfirmed
	}
	defer input.Close()
	command := `umask 077; set -eu; mkdir -p "$HOME/dant/releases"; stage=$(mktemp -d "$HOME/dant/releases/source.XXXXXX"); tar -xf - -C "$stage"; bash "$stage/vm/install-worker.sh" "$stage"`
	if _, err := deployer.options.Run(bounded, "ssh", append(SSHArgs(binding), binding.User+"@"+binding.Host, command), input); err != nil {
		deployer.set(contracts.ServiceUpdateStatusPending, "update-unconfirmed", false)
		return ErrDeploymentUnconfirmed
	}

	if err := current(); err != nil {
		return err
	}
	confirmed, err := deployer.remote(bounded, binding)
	if err != nil || !confirmed.matches(manifest, fingerprint) {
		deployer.set(contracts.ServiceUpdateStatusPending, "update-unconfirmed", false)
		return ErrDeploymentUnconfirmed
	}

	if err := current(); err != nil {
		return err
	}

	if _, err := deployer.attempts(binding, fingerprint, "clear"); err != nil {
		return err
	}
	deployer.set(contracts.ServiceUpdateStatusCurrent, "", true)
	return nil
}

func writeBundleTar(ctx context.Context, root, target string, manifest BundleManifest, raw []byte, fingerprint string, network config.Network) error {
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return ErrDeploymentUnavailable
	}
	defer file.Close()
	archive := tar.NewWriter(file)
	for _, entry := range manifest.Files {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := filepath.Join(root, filepath.FromSlash(entry.Path))
		if _, err := files.OrdinaryDirectory(filepath.Dir(name), false); err != nil {
			return ErrDeploymentUnavailable
		}
		before, err := os.Lstat(name)
		if err != nil || !before.Mode().IsRegular() || before.Size() != entry.Bytes {
			return ErrDeploymentUnavailable
		}
		input, err := os.Open(name)
		if err != nil {
			return ErrDeploymentUnavailable
		}
		readErr := func() error {
			defer input.Close()
			opened, err := input.Stat()
			if err != nil || !os.SameFile(before, opened) || !files.SingleLink(input) {
				return ErrDeploymentUnavailable
			}
			mode := int64(0600)
			if strings.HasSuffix(entry.Path, ".sh") || entry.Path == GuestBinaryPath {
				mode = 0700
			}
			if err := archive.WriteHeader(&tar.Header{Name: entry.Path, Mode: mode, Size: entry.Bytes, Typeflag: tar.TypeReg}); err != nil {
				return err
			}
			hash := sha256.New()
			copied, err := io.Copy(archive, io.TeeReader(io.LimitReader(input, entry.Bytes+1), hash))
			after, statErr := os.Lstat(name)
			if err != nil || statErr != nil || copied != entry.Bytes || hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 || !os.SameFile(before, after) || after.Size() != entry.Bytes || !after.ModTime().Equal(before.ModTime()) || !files.SingleLink(input) {
				return ErrDeploymentUnavailable
			}
			return nil
		}()
		if readErr != nil {
			return readErr
		}
	}
	add := func(name string, value []byte) error {
		if err := archive.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(value)), Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		_, err := archive.Write(value)
		return err
	}

	if err := add(BundleManifestPath, raw); err != nil {
		return err
	}
	public := struct {
		SchemaVersion     int               `json:"schemaVersion"`
		SHA256            string            `json:"sha256"`
		PublicEnvironment map[string]string `json:"publicEnvironment"`
	}{2, fingerprint, map[string]string{"DANT_GUEST_HOST": network.Guest.Host, "DANT_GUEST_PORT": strconv.Itoa(network.Guest.Port)}}
	deployment, _ := json.Marshal(public)
	if err := add("deploy-manifest.json", deployment); err != nil {
		return err
	}

	if err := archive.Close(); err != nil {
		return ErrDeploymentUnavailable
	}

	return file.Sync()
}
