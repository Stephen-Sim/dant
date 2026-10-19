import { randomUUID } from 'node:crypto';
import { INSTALL_LEASE_TTL_MS, DESKTOP_TRANSITION_TIMEOUT_MS } from '../config/limits.mts';
import { ConnectionStatus } from '../contracts/states.mts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export interface InstallLeaseReceipt {
  readonly leaseId: string;
  readonly expiresAt: number;
}
export interface InstallLeaseOptions {
  snapshot: () => unknown;
  refresh: () => unknown | Promise<unknown>;
  onFailure?: () => void;
  onRelease?: () => void;
  now?: () => number;
  ttlMs?: number;
  id?: () => string;
}
export interface MutationRequest {
  method: string;
  originalUrl?: string;
  path?: string;
}
export interface LeaseRequest {
  body?: unknown;
  params: Record<string, string | undefined>;
}
export interface LeaseResponse {
  status(code: number): LeaseResponse;
  json(value: unknown): unknown;
  setHeader(name: string, value: string): unknown;
}
export interface LeaseRouter {
  post(path: string, handler: (req: LeaseRequest, res: LeaseResponse) => unknown): unknown;
  delete(path: string, handler: (req: LeaseRequest, res: LeaseResponse) => unknown): unknown;
}

import { serviceUpdatePaused } from '../computer/vm-service-update.mts';

const blocked = () =>
  Object.assign(
    Error('Installation is deferred. Finish the call, computer control or setup, then try again.'),
    { status: 409 },
  );
export function installStateSafe(state: unknown): boolean {
  if (!isRecord(state) || !isRecord(state.controller) || !isRecord(state.provisioning))
    return false;
  const controller = state.controller,
    provisioning = state.provisioning;
  if (
    state.mode !== 'vm-controller' ||
    controller.authority !== 'vm' ||
    provisioning.running !== false ||
    typeof provisioning.status !== 'string' ||
    !['idle', 'ready', 'failed'].includes(provisioning.status)
  )
    return false;
  if (controller.vmConfigured === false)
    return (
      state.active === null &&
      state.call === null &&
      Array.isArray(state.queue) &&
      state.queue.length === 0 &&
      state.takeover === false &&
      !state.acquiring
    );
  return (
    controller.status === ConnectionStatus.Online &&
    controller.cached === false &&
    serviceUpdatePaused(state)
  );
}
export function updateSensitiveRequest(req: MutationRequest) {
  const url = req.originalUrl || req.path;
  if (!url) throw TypeError('A mutation request path is required.');
  const route = decodeURIComponent(new URL(url, 'http://localhost').pathname)
    .toLowerCase()
    .replace(/\/+$/, '');
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return false;
  return route.startsWith('/api/') && !/^\/api\/(?:desktop\/|updates(?:\/|$))/.test(route);
}

// The Controller supplies a pause-and-confirm refresh before reserving a lease.
// This fence prevents new work from entering between that pause and the installer.
export class UpdateInstallLease {
  readonly snapshot: () => unknown;
  readonly refresh: () => unknown | Promise<unknown>;
  readonly onFailure: () => void;
  readonly onRelease: () => void;
  readonly now: () => number;
  readonly ttlMs: number;
  readonly id: () => string;
  pending: number;
  checking: boolean;
  lease: InstallLeaseReceipt | null;
  uncertain: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  constructor({
    snapshot,
    refresh,
    onFailure = () => {},
    onRelease = () => {},
    now = Date.now,
    ttlMs = INSTALL_LEASE_TTL_MS,
    id = randomUUID,
  }: InstallLeaseOptions) {
    this.snapshot = snapshot;
    this.refresh = refresh;
    this.onFailure = onFailure;
    this.onRelease = onRelease;
    this.now = now;
    this.ttlMs = ttlMs;
    this.id = id;
    this.pending = 0;
    this.checking = false;
    this.lease = null;
    this.uncertain = false;
    this.closed = false;
  }
  current() {
    if (this.lease && this.lease.expiresAt <= this.now()) {
      this.lease = null;
      clearTimeout(this.timer);
      this.onRelease();
    }
    return this.lease;
  }
  arm() {
    clearTimeout(this.timer);
    if (this.lease) {
      this.timer = setTimeout(() => this.current(), Math.max(1, this.lease.expiresAt - this.now()));
      this.timer.unref?.();
    }
  }
  assertQuiescent(allowPending = 0) {
    if (
      this.closed ||
      this.checking ||
      this.current() ||
      this.pending > allowPending ||
      this.uncertain
    )
      throw blocked();
  }
  enter() {
    if (this.closed || this.checking || this.current()) throw blocked();
    this.pending++;
    let finished = false;
    return (error?: unknown) => {
      if (finished) return;
      finished = true;
      this.pending--;
      if (isRecord(error) && error.unknownOutcome === true) this.uncertain = true;
    };
  }
  async acquire() {
    if (this.closed || this.checking || this.current() || this.pending || this.uncertain)
      throw blocked();
    this.checking = true;
    try {
      await this.refresh();
      if (this.closed || this.pending || this.uncertain || !installStateSafe(this.snapshot()))
        throw blocked();
      this.lease = { leaseId: this.id(), expiresAt: this.now() + this.ttlMs };
      this.arm();
      return { ...this.lease };
    } catch {
      this.onFailure();
      throw blocked();
    } finally {
      this.checking = false;
    }
  }
  pin(id: unknown) {
    const lease = this.current();
    if (!lease || lease.leaseId !== id) throw blocked();
    this.lease = { ...lease, expiresAt: this.now() + DESKTOP_TRANSITION_TIMEOUT_MS };
    this.arm();
    return { ...this.lease };
  }
  renew(id: unknown) {
    const lease = this.current();
    if (!lease || lease.leaseId !== id) throw blocked();
    this.lease = { leaseId: lease.leaseId, expiresAt: this.now() + this.ttlMs };
    this.arm();
    return { ...this.lease };
  }
  release(id: unknown) {
    const lease = this.current();
    if (!lease || lease.leaseId !== id) throw blocked();
    this.lease = null;
    clearTimeout(this.timer);
    this.onRelease();
    return { released: true };
  }
  close() {
    this.closed = true;
    this.lease = null;
    clearTimeout(this.timer);
  }
}

export function installLeaseRoutes(app: LeaseRouter, lease: UpdateInstallLease) {
  app.post('/api/updates/install-lease', async (req, res) => {
    if (
      !req.body ||
      Array.isArray(req.body) ||
      typeof req.body !== 'object' ||
      Object.keys(req.body).length
    )
      return res.status(400).json({ error: 'An empty update installation request is required.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(await lease.acquire());
  });
  app.delete('/api/updates/install-lease/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(lease.release(req.params.id));
  });
}
