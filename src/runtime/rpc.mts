import { readRpcEvent } from './rpc-values.mts';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { diagnosticRpcMethod } from '../diagnostics/diagnostic-events.mts';
import { isRecord } from '../contracts/json.mts';
import type { RpcEnvelope, RpcParams } from './protocol.ts';

const REQUEST_TIMEOUT_MS = 60_000;
const STDERR_DIAGNOSTIC_CHARS = 2_000;
const DIAGNOSTIC_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV']);
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface DisconnectMetadata {
  reason: string;
  exitCode?: number;
  signal?: string;
  method?: string;
}
export class Rpc extends EventEmitter {
  next = 0;
  closed = false;
  readonly pending = new Map<string | number, PendingRequest>();
  readonly child: ChildProcessWithoutNullStreams;
  constructor(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio = {}) {
    super();
    this.child = spawn(command, [...args], {
      ...options,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('error', (error) => this.fail(error, { reason: 'process-error' }));
    this.child.on('close', (code, signal) =>
      this.fail(Error(`Worker disconnected (${code})`), {
        reason: 'process-closed',
        ...(code !== null && Number.isInteger(code) ? { exitCode: code } : {}),
        ...(signal !== null && DIAGNOSTIC_SIGNALS.has(signal) ? { signal } : {}),
      }),
    );
    this.child.stdin.on('error', (error) => this.fail(error, { reason: 'stdin-error' }));
    this.child.stderr.on('data', (data: Buffer) =>
      this.emit('diagnostic', data.toString().slice(-STDERR_DIAGNOSTIC_CHARS)),
    );
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch {}
    });
  }
  receive(message: unknown): void {
    if (!isRecord(message)) return;
    if (typeof message.method === 'string') {
      const event = readRpcEvent(message);
      if (event) this.emit('event', event);
      return;
    }
    if (typeof message.id !== 'string' && typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const source = isRecord(message.error) ? message.error : {};
      const error = Object.assign(
        Error(typeof source.message === 'string' ? source.message : 'Worker request failed'),
        { code: source.code, data: source.data },
      );
      pending.reject(error);
    } else pending.resolve(message.result);
  }
  send(message: RpcEnvelope): void {
    if (this.closed || this.child.stdin.destroyed) throw Error('Worker disconnected');
    this.child.stdin.write(JSON.stringify(message) + '\n', (error) => {
      if (error) this.fail(error, { reason: 'stdin-error' });
    });
  }
  request(method: string, params: RpcParams = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.emit('lifecycle', {
          code: 'rpc.timeout',
          method: diagnosticRpcMethod(method),
          durationMs: REQUEST_TIMEOUT_MS,
          count: this.pending.size,
        });
        this.fail(Error(`Timed out: ${method}`), {
          reason: 'timeout',
          method: diagnosticRpcMethod(method),
        });
        this.child.kill();
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  reply(id: string | number, result: unknown): void {
    this.send({ id, result });
  }
  fail(error: unknown, metadata: DisconnectMetadata = { reason: 'connection-error' }): void {
    if (this.closed) return;
    this.closed = true;
    const count = this.pending.size;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('lifecycle', { code: 'rpc.disconnected', ...metadata, count });
    this.emit('disconnected', error);
  }
  close(): void {
    this.child.kill();
    this.fail(Error('Worker stopped'), { reason: 'stopped' });
  }
}
