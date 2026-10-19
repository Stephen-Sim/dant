import { errorMessage, isRecord, includesValue } from '../contracts/json.mts';
import { ConnectionStatus } from '../contracts/states.mts';
import { readRpcResult } from './rpc-values.mts';
export interface LocalWorkerStore {
  state: { conversationId?: string; messages?: unknown[] };
}
import type { RpcParams, RpcResult } from './protocol.ts';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import type { SkillLibrary } from '../skills/skill-library.mts';
interface VmRuntimeOptions {
  platform?: NodeJS.Platform;
  uid?: number | undefined;
  detect?: () => string;
  fetchImpl?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
}
export interface ExecutorChild extends Pick<EventEmitter, 'once'> {
  kill(signal?: NodeJS.Signals): boolean;
}
export interface LocalRpcPort
  extends Pick<Rpc, 'request' | 'send' | 'reply' | 'close'>, Pick<EventEmitter, 'on'> {
  child?: ExecutorChild | null;
  closed?: boolean;
}
interface LocalWorkerOptions {
  rpcFactory?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => LocalRpcPort;
  platform?: NodeJS.Platform;
  home?: string;
  fetchImpl?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  verifyRuntime?: () => Promise<void>;
}
interface VoiceFile {
  path: string;
  type: 'audio/wav';
  [key: string]: unknown;
}
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Rpc } from './rpc.mts';
import { execFileSync, spawn } from 'node:child_process';
import { injectReactionContext } from '../conversation/reaction-context.mts';
import { injectMessageReferences } from '../conversation/message-references.mts';
import { readNetworkConfig, PROTOCOL_PATHS } from '../config/network.mts';

export async function assertVmRuntime({
  platform = process.platform,
  uid = process.getuid?.(),
  detect = () =>
    execFileSync('systemd-detect-virt', ['--vm'], { encoding: 'utf8', timeout: 5000 }).trim(),
  fetchImpl = fetch,
  environment = process.env,
}: VmRuntimeOptions = {}) {
  if (platform !== 'linux' || uid === 0)
    throw Error('The executor requires an ordinary user inside a Linux VM.');
  const guest = readNetworkConfig(environment).guest;
  let virtualization;
  try {
    virtualization = detect();
  } catch {
    throw Error('No virtual machine runtime was detected; execution was refused.');
  }
  if (!virtualization || virtualization === 'none')
    throw Error('No virtual machine runtime was detected; execution was refused.');
  const health = await fetchImpl(guest.httpOrigin + PROTOCOL_PATHS.health, {
    signal: AbortSignal.timeout(5000),
  });
  if (!health.ok) throw Error('The VM desktop bridge is not healthy.');
  const healthBody: unknown = await health.json();
  if (!health.ok || !isRecord(healthBody) || !healthBody.ok)
    throw Error('The VM desktop bridge is not healthy.');
  const screen = await fetchImpl(guest.httpOrigin + PROTOCOL_PATHS.screen, {
    signal: AbortSignal.timeout(10000),
  });
  const bytes = Buffer.from(await screen.arrayBuffer());
  if (!screen.ok || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw Error('The VM display is unavailable.');
}

// Only the VM service constructs this executor. A Controller never creates Rpc.
export class LocalWorker extends EventEmitter {
  readonly store: LocalWorkerStore;
  rpcFactory: NonNullable<LocalWorkerOptions['rpcFactory']>;
  platform: NodeJS.Platform;
  readonly home: string;
  fetchImpl: typeof fetch;
  verifyRuntime: () => Promise<void>;
  status: (typeof ConnectionStatus)[keyof typeof ConnectionStatus];
  error: string | null;
  generation: number;
  readonly network: ReturnType<typeof readNetworkConfig>;
  readonly runtimeId: string;
  workspaceRoot: string;
  readonly desktopPath: string;
  connecting: Promise<RpcResult> | null = null;
  rpc: LocalRpcPort | null | undefined;
  account: RpcResult | null = null;
  models: RpcResult | null = null;
  executorChild: ExecutorChild | null = null;
  executorClosed = true;
  executorClose: Promise<void> | null = null;
  credentialBridgeToken?: string;
  skills?: Pick<SkillLibrary, 'context'>;
  constructor(
    store: LocalWorkerStore,
    {
      rpcFactory = (command, args, options) => new Rpc(command, args, options),
      platform = process.platform,
      home = os.homedir(),
      fetchImpl = fetch,
      environment = process.env,
      verifyRuntime = () => assertVmRuntime({ fetchImpl, environment }),
    }: LocalWorkerOptions = {},
  ) {
    super();
    this.store = store;
    this.rpcFactory = rpcFactory;
    this.platform = platform;
    this.home = home;
    this.fetchImpl = fetchImpl;
    this.verifyRuntime = verifyRuntime;
    this.status = ConnectionStatus.Offline;
    this.error = null;
    this.generation = 0;
    this.network = readNetworkConfig(environment);
    this.runtimeId = process.env.DANT_RUNTIME_ID || `vm:${os.hostname()}:${os.userInfo().username}`;
    this.workspaceRoot = process.env.DANT_WORKSPACE_ROOT || path.join(home, 'dant/workspaces');
    this.desktopPath = path.join(home, 'dant/vm/desktop.py');
  }
  async connect() {
    if (this.platform !== 'linux')
      throw Error('Task execution is available only inside the Linux VM.');
    if (this.connecting) return this.connecting;
    this.disconnect();
    const generation = this.generation;
    const pending = this.open(generation).finally(() => {
      if (this.connecting === pending) this.connecting = null;
    });
    this.connecting = pending;
    return pending;
  }
  async open(generation: number): Promise<RpcResult> {
    this.status = ConnectionStatus.Connecting;
    this.error = null;
    this.emit('status');
    let rpc: LocalRpcPort | undefined;
    const current = () => {
      if (generation !== this.generation || rpc?.closed)
        throw Error('VM executor connection cancelled');
    };
    try {
      await this.verifyRuntime();
      current();
      const conversationId = this.store.state.conversationId;
      if (typeof conversationId !== 'string' || !conversationId)
        throw Error('The VM conversation identity is unavailable.');
      fs.mkdirSync(this.workspaceRoot, { recursive: true });
      const candidates = [
        path.join(this.home, '.local/bin/codex'),
        '/usr/local/bin/codex',
        '/usr/bin/codex',
      ];
      const command = candidates.find((file) => fs.existsSync(file));
      if (!command) throw Error('Codex is not installed in the VM.');
      const args = [
        '-c',
        'features.realtime_conversation=true',
        '-c',
        'mcp_servers.dant_desktop.command=' + JSON.stringify('/usr/bin/python3'),
        '-c',
        'mcp_servers.dant_desktop.args=' +
          JSON.stringify([
            path.join(this.home, 'dant/vm/desktop_mcp.py'),
            '--output-dir',
            path.join(this.workspaceRoot, conversationId, 'output'),
          ]),
        '-c',
        'mcp_servers.dant_desktop.env_vars=' +
          JSON.stringify(['DANT_CREDENTIAL_BRIDGE_TOKEN', 'DANT_CONTROL_FILE']),
        '-c',
        'mcp_servers.dant_desktop.tool_timeout_sec=660',
        'app-server',
        '--listen',
        'stdio://',
      ];
      rpc = this.rpcFactory(command, args, {
        cwd: this.workspaceRoot,
        env: {
          ...process.env,
          DANT_CREDENTIAL_BRIDGE_TOKEN: this.credentialBridgeToken || '',
          DISPLAY: ':0',
          CODEX_HOME: path.join(this.home, '.dant-codex'),
          PATH: `${path.join(this.home, '.local/bin')}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:${process.env.PATH || ''}`,
        },
      });
      this.rpc = rpc;
      if (rpc.child) {
        const child = rpc.child;
        this.executorChild = child;
        this.executorClosed = false;
        this.executorClose = new Promise<void>((resolve) =>
          child.once('close', () => {
            if (this.executorChild === child) this.executorClosed = true;
            resolve();
          }),
        );
      }
      rpc.on('event', (event) => {
        if (this.rpc === rpc) this.emit('event', event);
      });
      rpc.on('lifecycle', (event) => {
        if (this.rpc === rpc) this.emit('lifecycle', event);
      });
      rpc.on('disconnected', (error) => {
        if (this.rpc === rpc) {
          this.rpc = null;
          this.status = ConnectionStatus.Offline;
          this.account = null;
          this.models = null;
          this.error = errorMessage(error);
          this.emit('status');
        }
      });
      await rpc.request('initialize', {
        clientInfo: { name: 'dant', title: 'dant', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      current();
      rpc.send({ method: 'initialized' });
      const account = readRpcResult(await rpc.request('account/read', {}));
      current();
      this.account = account;
      const models = readRpcResult(await rpc.request('model/list', {}));
      current();
      this.models = models;
      this.status = ConnectionStatus.Online;
      this.error = null;
      this.emit('status');
      return this.account;
    } catch (error) {
      if (this.rpc === rpc) this.rpc = null;
      rpc?.close();
      if (generation === this.generation) {
        this.status = ConnectionStatus.Offline;
        this.error = errorMessage(error);
        this.emit('status');
      }
      throw error;
    }
  }
  disconnect() {
    this.generation++;
    this.connecting = null;
    if (this.rpc) {
      const rpc = this.rpc;
      this.rpc = null;
      rpc.close();
    }
    this.status = ConnectionStatus.Offline;
    this.account = null;
    this.models = null;
    this.emit('status');
  }
  async terminateConfirmed({ timeoutMs = 5000 }: { timeoutMs?: number } = {}) {
    const child = this.executorChild;
    if (!child || this.executorClosed) return { terminated: true };
    this.rpc?.close();
    if (!this.rpc) child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.executorClose,
        new Promise(
          (_resolve, reject) =>
            (timer = setTimeout(
              () =>
                reject(
                  Error(
                    'The VM executor has not confirmed that it stopped. Computer control remains blocked.',
                  ),
                ),
              timeoutMs,
            )),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!this.executorClosed) throw Error('The VM executor did not confirm shutdown.');
    return { terminated: true };
  }
  request(method: string, params: RpcParams = {}): Promise<RpcResult> {
    if (this.status !== 'online') throw Error('The VM executor is offline');
    let value: RpcParams = injectReactionContext(
      method,
      injectMessageReferences(method, params, this.store.state.messages || []),
      this.store.state.messages || [],
    );
    if (this.skills && ['turn/start', 'turn/steer', 'thread/realtime/start'].includes(method)) {
      const context = this.skills.context();
      if (method === 'thread/realtime/start')
        value = {
          ...value,
          realtimeStartInstructions: (value.realtimeStartInstructions || '') + '\n\n' + context,
        };
      else if (Array.isArray(value.input))
        value = {
          ...value,
          input: [...value.input, { type: 'text', text: context, text_elements: [] }],
        };
    }
    const rpc = this.rpc;
    if (!rpc) throw Error('The VM executor is offline');
    return rpc.request(method, value).then(readRpcResult);
  }
  async guest(route: string, body?: unknown) {
    const readOnlyScreen =
      this.platform === 'linux' && route === PROTOCOL_PATHS.screen && body === undefined;
    if (this.status !== 'online' && !readOnlyScreen) throw Error('The VM executor is offline');
    if (
      !includesValue(
        [
          PROTOCOL_PATHS.screen,
          PROTOCOL_PATHS.input,
          PROTOCOL_PATHS.control,
          PROTOCOL_PATHS.file,
          PROTOCOL_PATHS.readFile,
        ],
        route,
      )
    )
      throw Error('Unsupported desktop operation');
    let response;
    try {
      response = await this.fetchImpl(this.network.guest.httpOrigin + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (readOnlyScreen)
        throw Error('The VM desktop bridge could not be reached', { cause: error });
      throw error;
    }
    if (!response.ok) throw Error(`Desktop operation failed (${response.status})`);
    return response;
  }
  async upload(file: { originalname: string; path: string }) {
    return (
      await this.guest('/file', {
        name: file.originalname,
        data: fs.readFileSync(file.path).toString('base64'),
      })
    ).json();
  }
  async createVoiceMessage({
    text,
    outputDir,
    language,
  }: {
    text?: unknown;
    outputDir?: string;
    language?: string;
    voice?: string;
  } = {}): Promise<VoiceFile> {
    if (this.platform !== 'linux' || this.status !== 'online')
      throw Error('Voice files can only be created by the connected VM.');
    const directory = path.resolve(outputDir || ''),
      relative = path.relative(this.workspaceRoot, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw Error('Voice output must be inside the VM conversation workspace.');
    if (typeof text !== 'string' || !text.trim() || text.length > 2500)
      throw Error('Voice messages require 1–2500 characters.');
    return await new Promise<VoiceFile>((resolve, reject) => {
      let output = '',
        errorOutput = '',
        settled = false;
      const child = spawn(
        '/usr/bin/python3',
        [path.join(this.home, 'dant/vm/voice_message.py'), '--output-dir', directory],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const finish = (error: Error | null, result?: VoiceFile) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(Error('Invalid VM voice output.'));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(Error('VM speech generation timed out.'));
      }, 55000);
      child.once('error', () => finish(Error('Could not start VM speech generation.')));
      child.stdout.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-8192);
      });
      child.stderr.on('data', (chunk) => {
        errorOutput = (errorOutput + chunk.toString()).slice(-4096);
      });
      child.stdin.on('error', () => {});
      child.once('close', (code) => {
        if (code !== 0) {
          let reason;
          try {
            const parsed: unknown = JSON.parse(errorOutput);
            if (isRecord(parsed) && typeof parsed.error === 'string') reason = parsed.error;
          } catch {}
          finish(
            Error(reason || 'VM speech generation failed; check the local espeak-ng dependency.'),
          );
          return;
        }
        try {
          const result: unknown = JSON.parse(output);
          if (!isRecord(result) || typeof result.path !== 'string')
            throw Error('Invalid VM voice output.');
          const file = path.resolve(result.path);
          if (path.dirname(file) !== directory || result.type !== 'audio/wav')
            throw Error('Invalid VM voice output.');
          finish(null, { ...result, path: result.path, type: result.type });
        } catch {
          finish(Error('VM speech generation returned an invalid output.'));
        }
      });
      child.stdin.end(JSON.stringify({ text, language }));
    });
  }
}
