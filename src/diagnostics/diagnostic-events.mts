import type { IncomingMessage } from 'node:http';
import { isRecord } from '../contracts/json.mts';
import { ConnectionStatus, ServiceUpdateStatus, TaskStatus } from '../contracts/states.mts';
interface DiagnosticBridge {
  on(event: 'diagnostic', listener: (value: unknown) => void): unknown;
  removeListener(event: 'diagnostic', listener: (value: unknown) => void): unknown;
}
export interface DiagnosticSink {
  log(event: string, fields: Record<string, unknown>): unknown;
}
export interface ObservedMessage {
  id: string;
  role: string;
  status?: string;
  text?: string;
}
export interface DiagnosticRequest extends Pick<IncomingMessage, 'method' | 'url'> {
  originalUrl?: string;
  body?: unknown;
  headers?: unknown;
}
export interface DiagnosticResponse {
  statusCode: number;
  once(event: 'finish' | 'close', callback: () => void): unknown;
  removeListener(event: 'finish' | 'close', callback: () => void): unknown;
}
interface ObservedCall {
  id: string;
  status: string;
  provider?: string | undefined;
}
const fixedRoutes = new Set(
  [
    'session',
    'state',
    'events',
    'diagnostics',
    'version',
    'updates',
    'settings',
    'connect',
    'prepare',
    'provision',
    'login',
    'logout',
    'voice-key',
    'messages',
    'realtime/message',
    'memory',
    'read',
    'stop',
    'tasks/pause',
    'tasks/resume',
    'steer',
    'takeover',
    'screen',
    'input',
    'upload',
    'call',
    'call/connected',
    'call/stop',
    'voices',
    'schedules',
    'credentials',
    'skills',
    'skills/import/preview',
    'skills/import',
    'controller/settings',
    'backups',
    'backups/settings',
    'backups/run',
    'backups/import',
    'backups/export',
    'backups/info',
    'memory/manage',
    'history',
    'fonts',
    'vm/profiles',
    'vm/providers',
    'vm/import',
    'notifications/pending',
    'telegram',
    'telegram/config',
    'telegram/pair',
    'telegram/disconnect',
    'internal/credentials',
  ].map((route) => '/api/' + route),
);
fixedRoutes.add('/api/tasks/clear-completed');
const variableRoutes: [RegExp, string][] = [
  [/^\/api\/messages\/[^/]+\/reaction$/, '/api/messages/:id/reaction'],
  [/^\/api\/messages\/[^/]+$/, '/api/messages/:id'],
  [/^\/api\/credentials\/requests\/[^/]+$/, '/api/credentials/requests/:id'],
  [/^\/api\/credentials\/[^/]+$/, '/api/credentials/:id'],
  [/^\/api\/skills\/[^/]+$/, '/api/skills/:name'],
  [/^\/api\/skills\/[^/]+\/export$/, '/api/skills/:name/export'],
  [/^\/api\/skills\/import\/previews\/[^/]+$/, '/api/skills/import/previews/:id'],
  [/^\/api\/backups\/[^/]+\/preview$/, '/api/backups/:id/preview'],
  [/^\/api\/backups\/[^/]+\/restore$/, '/api/backups/:id/restore'],
  [/^\/api\/backups\/[^/]+\/export$/, '/api/backups/:id/export'],
  [/^\/api\/memory\/manage\/[^/]+\/[^/]+$/, '/api/memory/manage/:kind/:id'],
  [/^\/api\/memory\/manage\/[^/]+\/[^/]+\/confirm$/, '/api/memory/manage/:kind/:id/confirm'],
  [/^\/api\/memory\/[^/]+$/, '/api/memory/:name'],
  [/^\/api\/files\/[^/]+$/, '/api/files/:id'],
  [/^\/api\/retry\/[^/]+$/, '/api/retry/:id'],
  [/^\/api\/tasks\/[^/]+\/accept$/, '/api/tasks/:id/accept'],
  [/^\/api\/schedules\/[^/]+$/, '/api/schedules/:id'],
  [/^\/api\/notifications\/[^/]+\/ack$/, '/api/notifications/:id/ack'],
];
for (const action of ['pause', 'resume', 'cancel', 'priority', 'dismiss', 'context'])
  variableRoutes.push([
    new RegExp('^/api/tasks/[^/]+/' + action + '$'),
    '/api/tasks/:id/' + action,
  ]);
variableRoutes.push([
  /^\/api\/messages\/[^/]+\/output-link\/resolve$/,
  '/api/messages/:id/output-link/resolve',
]);
export function diagnosticRoute(url: unknown) {
  const route = String(url || '').split('?')[0] ?? '';
  if (fixedRoutes.has(route)) return route;
  for (const [pattern, template] of variableRoutes) if (pattern.test(route)) return template;
  return '/api/:unknown';
}
const rpcMethods = new Set([
  'initialize',
  'account/read',
  'account/login/start',
  'account/logout',
  'model/list',
  'skills/list',
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/inject_items',
  'thread/realtime/start',
  'thread/realtime/stop',
  'thread/realtime/appendText',
  'thread/realtime/listVoices',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
]);
export const diagnosticRpcMethod = (method: unknown) =>
  typeof method === 'string' && rpcMethods.has(method) ? method : 'other';
export function serviceVersion(projectRoot: string) {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    );
    const version = isRecord(value) ? value.version : undefined;
    return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
      ? version
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
const workerStates = new Set<string>(Object.values(ConnectionStatus));
const callStates = new Set([
  'starting',
  'connecting',
  'negotiating',
  'connected',
  'stopping',
  'stop-unconfirmed',
]);
export const diagnosticWorkerStatus = (status: unknown) =>
  typeof status === 'string' && workerStates.has(status) ? status : 'unknown';
const serviceUpdateStatuses = new Set<string>(Object.values(ServiceUpdateStatus));
const serviceUpdatePhases = new Set([
  'check',
  'prepare',
  'pause',
  'activate',
  'connect',
  'verify',
  'rollback',
]);
const serviceUpdateReasons = new Set([
  'source-current',
  'work-active',
  'executor-offline',
  'connection-unavailable',
  'update-unconfirmed',
  'update-failed',
  'version-unconfirmed',
  'version-mismatch',
  'configuration-invalid',
  'cancelled',
  'not-configured',
  'session-unavailable',
  'session-invalid',
  'state-unavailable',
  'state-invalid',
  'control-busy',
  'work-unconfirmed',
  'call-owner-invalid',
  'pause-unconfirmed',
  'call-owner-changed',
  'call-stop-unconfirmed',
  'saved-pause-unconfirmed',
  'work-still-active',
  'request-unconfirmed',
  'idle-unconfirmed',
]);
const serviceUpdateStages = new Set([
  'initial',
  'pause',
  'post-pause',
  'call-stop',
  'saved-pause',
  'final',
  'rollback',
]);
const metadataValue = (object: object, key: string): unknown => {
  const field = Object.getOwnPropertyDescriptor(object, key);
  return field && Object.hasOwn(field, 'value') ? field.value : undefined;
};
// Bridge diagnostics are a separate fixed event contract. Never forward the
// bridge's raw Error, SSH stdout, connection binding or task snapshot to logs.
export function observeBridge(diagnostics: DiagnosticSink, bridge: DiagnosticBridge) {
  const listener = (value: unknown) => {
    try {
      if (
        !value ||
        typeof value !== 'object' ||
        metadataValue(value, 'event') !== 'vm.service-update'
      )
        return;
      const fields = metadataValue(value, 'fields');
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return;
      const status = metadataValue(fields, 'status');
      if (typeof status !== 'string' || !serviceUpdateStatuses.has(status)) return;
      const safe: Record<string, string | number | boolean> = { status },
        phase = metadataValue(fields, 'phase'),
        reason = metadataValue(fields, 'reason'),
        stage = metadataValue(fields, 'stage');
      if (typeof phase === 'string' && serviceUpdatePhases.has(phase)) safe.phase = phase;
      if (typeof reason === 'string' && serviceUpdateReasons.has(reason)) safe.reason = reason;
      if (typeof stage === 'string' && serviceUpdateStages.has(stage)) safe.stage = stage;
      for (const key of ['targetVersion', 'runningVersion']) {
        const version = metadataValue(fields, key);
        if (
          typeof version === 'string' &&
          version.length <= 64 &&
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
        )
          safe[key] = version;
      }
      for (const key of ['durationMs', 'attempt', 'exitCode']) {
        const count = metadataValue(fields, key);
        if (
          typeof count === 'number' &&
          Number.isSafeInteger(count) &&
          count >= 0 &&
          count <= Number.MAX_SAFE_INTEGER
        )
          safe[key] = count;
      }
      const unknownOutcome = metadataValue(fields, 'unknownOutcome');
      if (typeof unknownOutcome === 'boolean') safe.unknownOutcome = unknownOutcome;
      diagnostics.log('vm.service-update', safe);
    } catch {} // Diagnostics must never fail connection or update control flow.
  };
  bridge.on('diagnostic', listener);
  return () => bridge.removeListener('diagnostic', listener);
}
const taskStates = new Set<string>(Object.values(TaskStatus));
export function observeTasks(
  diagnostics: DiagnosticSink,
  store: { state: { messages: ObservedMessage[] } },
  engine: { call?: ObservedCall | null },
) {
  const states = new Map(
    (store.state.messages || [])
      .filter((message) => message.role === 'user')
      .map((message) => [message.id, message.status]),
  );
  let call = engine.call
    ? { id: engine.call.id, status: engine.call.status, provider: engine.call.provider }
    : null;
  return () => {
    const present = new Set<string>();
    for (const message of store.state.messages || []) {
      if (message.role !== 'user') continue;
      present.add(message.id);
      if (states.get(message.id) !== message.status) {
        states.set(message.id, message.status);
        diagnostics.log('task.status', {
          messageId: message.id,
          status: taskStates.has(message.status ?? '') ? message.status : 'unknown',
        });
      }
    }
    for (const id of states.keys()) if (!present.has(id)) states.delete(id);
    const current = engine.call;
    if (call && call.id !== current?.id)
      diagnostics.log('call.closed', {
        callId: call.id,
        provider: ['api', 'subscription'].includes(call.provider ?? '') ? call.provider : 'unknown',
      });
    if (current && (!call || call.id !== current.id || call.status !== current.status))
      diagnostics.log('call.status', {
        callId: current.id,
        provider: ['api', 'subscription'].includes(current.provider ?? '')
          ? current.provider
          : 'unknown',
        status: callStates.has(current.status) ? current.status : 'unknown',
      });
    call = current ? { id: current.id, status: current.status, provider: current.provider } : null;
  };
}
export function observeHttp(
  diagnostics: DiagnosticSink,
  { now = () => performance.now(), slowMs = 2000 }: { now?: () => number; slowMs?: number } = {},
) {
  return (req: DiagnosticRequest, res: DiagnosticResponse, next: () => void) => {
    const url = String(req.originalUrl || req.url || '');
    if (url !== '/api' && !url.startsWith('/api/')) return next();
    const start = now(),
      route = diagnosticRoute(url),
      method =
        typeof req.method === 'string' &&
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method)
          ? req.method
          : 'OTHER';
    let completed = false;
    const record = (aborted: boolean) => {
      if (completed) return;
      completed = true;
      res.removeListener('finish', finished);
      res.removeListener('close', closed);
      const durationMs = Math.max(0, Math.round(now() - start)),
        status = aborted ? 499 : res.statusCode;
      if (!aborted && status < 400 && (durationMs < slowMs || route === '/api/events')) return;
      const reason = aborted
        ? 'client-aborted'
        : status >= 500
          ? 'server-error'
          : status === 401
            ? 'unauthorized'
            : status === 403
              ? 'forbidden'
              : status === 404
                ? 'not-found'
                : status === 409
                  ? 'conflict'
                  : status === 413
                    ? 'too-large'
                    : status >= 400
                      ? 'request-rejected'
                      : 'slow-request';
      diagnostics.log('http.request', { method, route, status, durationMs, reason });
    };
    const finished = () => record(false),
      closed = () => record(true);
    res.once('finish', finished);
    res.once('close', closed);
    next();
  };
}
import fs from 'node:fs';
import path from 'node:path';
