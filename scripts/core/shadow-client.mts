import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isRecord } from './manifest-json.mts';
import type { JsonObject } from './manifest-json.mts';
import protocol from '../../resources/contracts/core-protocol.json' with { type: 'json' };

/** Read-only developer protocol descriptor; it has no production memory dependency. */
export interface ReadonlyShadowSnapshot {
  readonly file: string;
  readonly revision: number;
}

type Method = 'ping' | 'search' | 'retrieve';
const ShadowErrorCode = Object.freeze({
  Unavailable: 'core_unavailable',
  Closed: 'core_closed',
  TransportFailed: 'core_transport_failed',
  FrameTooLarge: 'core_frame_too_large',
  InvalidResponse: 'core_invalid_response',
  ResponseIdentity: 'core_response_identity',
  Cancelled: 'core_cancelled',
  InvalidDeadline: 'core_invalid_deadline',
  Busy: 'core_busy',
  SessionLimit: 'core_session_limit',
  Deadline: 'core_deadline',
  ShutdownUnconfirmed: 'core_shutdown_unconfirmed',
} as const);
type ShadowErrorCodeValue = (typeof ShadowErrorCode)[keyof typeof ShadowErrorCode];
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
}

/** Developer shadow transport: bounded, one process per snapshot, never retries requests. */
export class ShadowClient {
  private readonly pending = new Map<string, Pending>();
  private readonly discarded = new Set<string>();
  private readonly input: Writable;
  private buffer = Buffer.alloc(0);
  private issued = 0;
  private failure: Error | null = null;
  private readonly exited: Promise<void>;
  private readonly child: ChildProcess;
  private closing = false;
  private closeResult: Promise<void> | null = null;

  constructor(child: ChildProcess) {
    this.child = child;
    if (!child.stdin || !child.stdout) throw Error('Core shadow requires piped transport');
    this.input = child.stdin;
    this.exited = new Promise((resolve) => {
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
    });
    child.once('error', () => this.fail(ShadowErrorCode.Unavailable));
    child.once('close', () => this.fail(ShadowErrorCode.Closed));
    this.input.on('error', () => this.fail(ShadowErrorCode.TransportFailed));
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
  }

  private fail(code: ShadowErrorCodeValue): void {
    if (this.failure) return;
    this.failure = Error(code);
    this.rejectPending(this.failure);
    this.buffer = Buffer.alloc(0);
    this.input.destroy();
    // This process can only read an isolated snapshot. A broken protocol never
    // leaves a replacement helper or executable action running in the background.
    this.child.kill('SIGKILL');
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private receive(chunk: Buffer): void {
    if (this.failure || this.closing) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > protocol.responseMaxBytes)
          this.fail(ShadowErrorCode.FrameTooLarge);
        return;
      }
      if (newline > protocol.responseMaxBytes) {
        this.fail(ShadowErrorCode.FrameTooLarge);
        return;
      }
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      let response: unknown;
      try {
        response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
      } catch {
        this.fail(ShadowErrorCode.InvalidResponse);
        return;
      }
      if (!isRecord(response) || typeof response.id !== 'string') {
        this.fail(ShadowErrorCode.InvalidResponse);
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) {
        if (this.discarded.delete(response.id)) continue;
        this.fail(ShadowErrorCode.ResponseIdentity);
        return;
      }
      const hasResult = Object.hasOwn(response, 'result');
      const hasError = Object.hasOwn(response, 'error');
      if (
        hasResult === hasError ||
        Object.keys(response).some((key) => key !== 'id' && key !== 'result' && key !== 'error')
      ) {
        this.fail(ShadowErrorCode.InvalidResponse);
        return;
      }
      if (
        hasError &&
        (!isRecord(response.error) ||
          typeof response.error.code !== 'string' ||
          !/^[a-z_]{1,64}$/.test(response.error.code) ||
          Object.keys(response.error).length !== 1)
      ) {
        this.fail(ShadowErrorCode.InvalidResponse);
        return;
      }
      this.pending.delete(response.id);
      pending.cleanup();
      if (hasError && isRecord(response.error) && typeof response.error.code === 'string')
        pending.reject(Error(response.error.code));
      else pending.resolve(response.result);
    }
  }

  request(
    method: Method,
    params: JsonObject = {},
    {
      signal,
      deadlineMs = protocol.defaultDeadlineMs,
    }: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<unknown> {
    if (this.closing) return Promise.reject(Error(ShadowErrorCode.Closed));
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(Error(ShadowErrorCode.Cancelled));
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > protocol.maxDeadlineMs)
      return Promise.reject(Error(ShadowErrorCode.InvalidDeadline));
    if (this.pending.size >= protocol.workers + protocol.queueCapacity)
      return Promise.reject(Error(ShadowErrorCode.Busy));
    if (this.issued >= protocol.maxSessionRequests)
      return Promise.reject(Error(ShadowErrorCode.SessionLimit));
    const id = randomUUID();
    const frame = JSON.stringify({ id, method, params, deadlineMs }) + '\n';
    const bytes = Buffer.byteLength(frame);
    if (bytes - 1 > protocol.requestMaxBytes)
      return Promise.reject(Error(ShadowErrorCode.FrameTooLarge));
    if (
      this.input.writableLength + bytes >
      protocol.requestMaxBytes * (protocol.workers + protocol.queueCapacity)
    )
      return Promise.reject(Error(ShadowErrorCode.Busy));
    this.issued++;
    return new Promise((resolve, reject) => {
      const cancel = (code: ShadowErrorCodeValue) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.discarded.add(id);
        pending.cleanup();
        reject(Error(code));
        if (!this.failure) this.input.write(JSON.stringify({ cancel: id }) + '\n');
      };
      const abort = () => cancel(ShadowErrorCode.Cancelled);
      const timer = setTimeout(() => cancel(ShadowErrorCode.Deadline), deadlineMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.input.write(frame);
    });
  }

  private waitForExit(): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), protocol.shutdownMs);
      void this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async shutdown(): Promise<void> {
    if (!this.input.destroyed) this.input.end();
    try {
      if (!(await this.waitForExit())) {
        this.child.kill('SIGKILL');
        if (!(await this.waitForExit())) throw Error(ShadowErrorCode.ShutdownUnconfirmed);
      }
    } finally {
      this.failure ??= Error(ShadowErrorCode.Closed);
      this.buffer = Buffer.alloc(0);
      this.input.destroy();
      this.child.stdout?.destroy();
      this.child.unref();
    }
  }

  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.closing = true;
    this.rejectPending(Error(ShadowErrorCode.Closed));
    this.closeResult = this.shutdown();
    return this.closeResult;
  }
}

export function startShadowClient(
  executable: string,
  snapshot: ReadonlyShadowSnapshot,
): ShadowClient {
  if (
    !path.isAbsolute(executable) ||
    !path.isAbsolute(snapshot.file) ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0
  )
    throw Error('Invalid core shadow launch');
  return new ShadowClient(
    spawn(
      executable,
      ['--role=memory-shadow', '--snapshot=' + snapshot.file, '--revision=' + snapshot.revision],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        shell: false,
      },
    ),
  );
}
