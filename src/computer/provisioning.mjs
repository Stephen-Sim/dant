import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { detectHypervisors, selectHypervisor } from './hypervisors.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parseFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

// This controller performs no installation until start() is called by the UI.
// spawnProcess and timing overrides keep regression tests away from real UAC/VMs.
export class Provisioning extends EventEmitter {
  constructor({
    projectRoot = defaultRoot,
    dataDir = path.join(projectRoot, 'data'),
    spawnProcess = spawn,
    platform = process.platform,
    detectProviders = () => detectHypervisors({ platform }),
    probeIntervalMs = 15000,
    installTimeoutMs = 45 * 60 * 1000,
  } = {}) {
    super();
    this.projectRoot = path.resolve(projectRoot);
    this.dataDir = path.resolve(dataDir);
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.detectProviders = detectProviders;
    this.probeIntervalMs = probeIntervalMs;
    this.installTimeoutMs = installTimeoutMs;
    this.running = false;
    this.closed = false;
    this.child = null;
    this.state = {
      status: 'idle',
      stage: 'idle',
      provider: null,
      selected: 'auto',
      availableProviders: [],
      error: null,
      startedAt: null,
      updatedAt: Date.now(),
      connection: null,
      log: null,
      output: '',
    };
    this.refresh();
  }
  snapshot() {
    this.refresh();
    return structuredClone({ ...this.state, running: this.running });
  }
  providers() {
    this.refresh();
    this.state.availableProviders = this.detectProviders();
    return structuredClone({
      selected: this.state.selected,
      provider:
        this.state.provider ||
        (!this.state.connection
          ? this.state.availableProviders.find((item) => item.available)?.id
          : null) ||
        null,
      availableProviders: this.state.availableProviders,
    });
  }
  set(update) {
    Object.assign(this.state, update, { updatedAt: Date.now() });
    if (!this.closed) this.emit('change', this.snapshot());
  }
  refresh() {
    let configuredProvider = null;
    try {
      const connection = parseFile(path.join(this.dataDir, 'vm.json'));
      if (typeof connection.host === 'string' && typeof connection.user === 'string') {
        this.state.connection = Object.fromEntries(
          ['host', 'user', 'port', 'keyPath', 'knownHosts', 'provider', 'name', 'vmxPath']
            .filter((key) => connection[key] !== undefined)
            .map((key) => [key, connection[key]]),
        );
        if (['hyperv', 'vmware', 'ssh'].includes(connection.provider)) {
          configuredProvider = connection.provider;
          this.state.provider = configuredProvider;
        }
      }
    } catch {
      /* PowerShell can briefly leave a partial JSON file while writing. */
    }
    try {
      const file = path.join(this.dataDir, 'vm-setup-status.json');
      if (
        !this.resuming &&
        this.state.startedAt &&
        fs.statSync(file).mtimeMs < this.state.startedAt
      )
        return;
      const progress = parseFile(file);
      if (typeof progress.stage !== 'string') return;
      if (!configuredProvider)
        this.state.provider = ['hyperv', 'vmware'].includes(progress.provider)
          ? progress.provider
          : this.state.provider || 'hyperv';
      if (['auto', 'hyperv', 'vmware'].includes(progress.selected))
        this.state.selected = progress.selected;
      const failed = progress.stage === 'failed' || progress.stage.startsWith('failed:');
      if (this.state.status === 'failed' && !failed && progress.stage !== 'ready') return;
      if (this.state.status === 'ready' && progress.stage !== 'ready') return;
      this.state.stage = progress.stage;
      this.state.log = typeof progress.log === 'string' ? progress.log : this.state.log;
      if (failed) {
        this.state.status = 'failed';
        this.state.error = this.failure || String(progress.error || 'VM setup failed');
      } else if (progress.stage === 'ready') {
        this.state.status = 'ready';
        this.state.error = null;
      } else if (progress.stage === 'guest-installing') {
        this.state.status = 'installing';
        this.state.error = null;
      } else {
        this.state.status = ['awaiting-admin', 'preparing'].includes(progress.stage)
          ? progress.stage
          : 'creating';
      }
    } catch {
      /* Missing or incomplete progress is normal before the script starts. */
    }
  }
  start(options = {}) {
    if (this.closed) throw Error('VM setup controller is closed');
    if (this.platform !== 'win32') throw Error('Automatic VM setup requires Windows');
    if (this.running) throw Error('VM setup is already running');
    this.refresh();
    if (['creating', 'awaiting-admin'].includes(this.state.status))
      throw Error(
        'An earlier VM setup is still in progress or needs recovery; existing VM files have been preserved',
      );
    if (this.state.connection || fs.existsSync(path.join(this.dataDir, 'vm.json')))
      throw Error('A VM is already configured; connect to it instead of creating another');
    if (
      (fs.existsSync(path.join(this.dataDir, 'vm')) &&
        fs.readdirSync(path.join(this.dataDir, 'vm')).length) ||
      ['dant.vmx', 'dant.vmdk'].some((name) =>
        fs.existsSync(path.join(this.dataDir, 'vmware', name)),
      )
    )
      throw Error(
        'Existing VM disk files have been preserved. Recover the existing VM instead of creating another.',
      );
    const values = {
      cpu: 4,
      memoryGB: 6,
      diskGB: 40,
      adminSudo: false,
      provider: 'auto',
      ...options,
    };
    for (const [key, min, max] of [
      ['cpu', 1, 64],
      ['memoryGB', 2, 128],
      ['diskGB', 32, 2048],
    ])
      if (!Number.isInteger(values[key]) || values[key] < min || values[key] > max)
        throw Error(`Invalid ${key}: expected an integer from ${min} to ${max}`);
    if (typeof values.adminSudo !== 'boolean') throw Error('adminSudo must be a boolean');
    const availableProviders = this.providers().availableProviders,
      provider = selectHypervisor({
        requested: values.provider,
        preferred: this.state.provider,
        availableProviders,
      });
    const tools = availableProviders.find((item) => item.id === provider)?.tools;
    values.provider = provider;
    values.tools = tools;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.state.provider = provider;
    this.state.selected = options.provider || 'auto';
    this.state.startedAt = Date.now();
    this.saveProgress('preparing');
    this.running = true;
    this.resuming = false;
    this.failure = null;
    this.controller = new AbortController();
    this.set({ status: 'preparing', stage: 'preparing', error: null, output: '', log: null });
    this.track(this.run(values));
    return this.snapshot();
  }
  resumeMonitoring() {
    if (this.closed) throw Error('VM setup controller is closed');
    if (this.running) return this.snapshot();
    this.refresh();
    if (!['creating', 'awaiting-admin', 'installing'].includes(this.state.status))
      return this.snapshot();
    if (this.platform !== 'win32') throw Error('VM setup monitoring requires Windows');
    this.running = true;
    this.resuming = true;
    this.failure = null;
    this.controller = new AbortController();
    this.set({ error: null, startedAt: this.state.startedAt || Date.now() });
    this.track(this.watchExisting());
    return this.snapshot();
  }
  track(task) {
    this.poll = setInterval(() => {
      const before = JSON.stringify(this.state);
      this.refresh();
      if (JSON.stringify(this.state) !== before) this.set({});
    }, 750);
    this.poll.unref();
    this.task = task
      .catch((error) => {
        if (!this.closed) {
          this.failure = error.message;
          const stage =
            this.state.stage === 'failed' || this.state.stage.startsWith('failed:')
              ? this.state.stage
              : `failed:${this.state.stage}`;
          try {
            if (!this.resuming) this.saveProgress(stage, error.message);
          } catch {}
          this.set({ status: 'failed', stage, error: error.message });
        }
      })
      .finally(() => {
        clearInterval(this.poll);
        this.running = false;
        if (!this.closed) this.set({});
      });
  }
  saveProgress(stage, error = null) {
    const file = path.join(this.dataDir, 'vm-setup-status.json');
    let previous = {};
    try {
      previous = parseFile(file);
    } catch {}
    const temporary = path.join(this.dataDir, `.vm-progress-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify({
          ...previous,
          provider: this.state.provider,
          selected: this.state.selected,
          stage,
          error,
          updatedAt: new Date().toISOString(),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  async watchExisting() {
    const deadline = Date.now() + this.installTimeoutMs;
    while (Date.now() < deadline) {
      this.ensureOpen();
      this.refresh();
      if (this.state.status === 'failed')
        throw Error(`${this.state.error}. Existing VM and disk files have been preserved.`);
      if (this.state.status === 'ready') return;
      if (this.state.status === 'installing' && this.state.connection) {
        await this.verifyReady();
        return;
      }
      await this.delay(Math.min(this.probeIntervalMs, 1000));
    }
    throw Error(
      'VM setup has not reported completion. Monitoring stopped; the administrator setup process may still be running. Existing VM and disk files have been preserved.',
    );
  }
  async run(values) {
    const dataArgs = ['-DataDirectory', this.dataDir];
    const vmware = values.provider === 'vmware',
      tools =
        vmware && values.tools
          ? ['-VmrunPath', values.tools.vmrun, '-VdiskmanagerPath', values.tools.vdiskmanager]
          : [];
    await this.execute(vmware ? 'prepare-vmware.ps1' : 'prepare-vm.ps1', [
      ...dataArgs,
      ...tools,
      ...(values.adminSudo ? ['-AdminSudo'] : []),
    ]);
    this.ensureOpen();
    this.saveProgress(vmware ? 'creating' : 'awaiting-admin');
    this.set({
      status: vmware ? 'creating' : 'awaiting-admin',
      stage: vmware ? 'creating' : 'awaiting-admin',
    });
    await this.execute(vmware ? 'create-vmware.ps1' : 'launch-vm.ps1', [
      ...dataArgs,
      ...tools,
      '-Cpu',
      String(values.cpu),
      '-MemoryGB',
      String(values.memoryGB),
      '-DiskGB',
      String(values.diskGB),
    ]);
    this.ensureOpen();
    this.refresh();
    if (!this.state.connection) throw Error('VM creation finished without connection details');
    this.set({ status: 'installing', stage: 'guest-installing', error: null });
    await this.verifyReady();
  }
  async verifyReady() {
    const deadline = Date.now() + this.installTimeoutMs;
    while (Date.now() < deadline) {
      this.ensureOpen();
      try {
        await this.execute('check-vm.ps1', ['-DataDirectory', this.dataDir]);
        this.saveProgress('ready');
        this.set({ status: 'ready', stage: 'ready', error: null });
        return;
      } catch (error) {
        if (this.closed) throw error;
        this.refresh();
        if (this.state.status === 'failed')
          throw Error(`${this.state.error}. Existing VM and disk files have been preserved.`);
      }
      await this.delay(this.probeIntervalMs);
    }
    throw Error(
      'The VM was created, but its desktop is still installing. Check the setup log before retrying; the existing VM has been preserved.',
    );
  }
  ensureOpen() {
    if (this.closed || this.controller?.signal.aborted) throw Error('VM setup monitoring stopped');
  }
  delay(ms) {
    return new Promise((resolve, reject) => {
      const signal = this.controller.signal;
      const onAbort = () => {
        clearTimeout(timer);
        reject(Error('VM setup monitoring stopped'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
  execute(script, args) {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      let settled = false,
        output = '';
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (this.child === child) this.child = null;
        error ? reject(error) : resolve();
      };
      let child;
      try {
        child = this.spawnProcess(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(this.projectRoot, 'scripts', script),
            ...args,
          ],
          {
            cwd: this.projectRoot,
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        this.child = child;
      } catch (error) {
        finish(error);
        return;
      }
      const collect = (data) => {
        const text = data.toString().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        output = (output + text).slice(-4096);
        this.set({ output: (this.state.output + text).slice(-8192) });
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        this.refresh();
        if (code === 0) {
          finish();
          return;
        }
        const cancelled = code === 1223 || output.includes('DANT_UAC_CANCELLED');
        finish(
          Error(
            cancelled
              ? 'Administrator approval was cancelled. Click setup again when you are ready.'
              : this.state.error ||
                  `${script} failed (${code ?? 'stopped'}). ${output.trim().slice(-700)}`,
          ),
        );
      });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.controller?.abort();
    clearInterval(this.poll);
    // Terminate only our direct, non-elevated helper. Do not use taskkill /T:
    // an elevated create-vm process and its VM must be allowed to finish safely.
    this.child?.kill();
    this.child = null;
    this.removeAllListeners();
  }
}
