import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import type { VmObservation } from '../computer/vm-observation-types.ts';
import type { VmRequestOptions } from '../computer/vm-bridge.mts';
import type { VmBinding } from '../computer/computer-types.ts';
import type { ControllerAppOptions, ControllerConfig, PreferenceSync } from './controller-types.ts';
import { isRecord, errorMessage, includesValue } from '../contracts/json.mts';
type ControllerRequest = Request<ParamsDictionary, unknown, unknown>;
type ControllerHandler = (
  req: ControllerRequest,
  res: Response<unknown>,
  next: NextFunction,
) => unknown;
function jsonBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw Object.assign(Error('An object request is required.'), { status: 400 });
  return value;
}
function observedObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
import {
  DesktopPhase,
  ConnectionStatus,
  TaskPriority,
  ComputerControlStatus,
  ProvisioningStatus,
} from '../contracts/states.mts';
import { allowedLocalOrigin, NATIVE_PROTOCOL } from '../config/network.mts';
import { VmLifecycle } from '../computer/vm-lifecycle.mts';
import { DesktopLifecycle } from './desktop-lifecycle.mts';
import { isLanguage, normalizeLanguage, languageForWorker } from '../i18n/languages.mts';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { VmBridge } from '../computer/vm-bridge.mts';
import { Provisioning } from '../computer/provisioning.mts';
import { VmProfiles, readVmBinding, normalizeVmBinding } from '../computer/vm-profiles.mts';
import { NotificationHub } from '../conversation/notifications.mts';
import { createSecretStore } from '../security/secrets.mts';
import {
  appearanceDefaults,
  appearanceKeys,
  readAppearance,
  validateAppearancePatch,
  listSystemFonts,
} from '../settings/appearance.mts';
import { Diagnostics } from '../diagnostics/diagnostics.mts';
import {
  observeHttp,
  observeBridge,
  serviceVersion,
  diagnosticWorkerStatus,
} from '../diagnostics/diagnostic-events.mts';
import { VmServiceUpdateLoop } from '../computer/vm-service-update.mts';
import { UpdateService, installUpdateRoutes } from '../updates/updates.mts';
import {
  UpdateInstallLease,
  installLeaseRoutes,
  updateSensitiveRequest,
} from '../updates/update-install-lease.mts';

const parse = (file: string): Record<string, unknown> =>
  jsonBody(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
const allowedOrigin = (origin: unknown) =>
  allowedLocalOrigin(
    origin,
    process.env.DANT_MANAGED
      ? { DANT_PORT: NATIVE_PROTOCOL.port, DANT_DEV_PORT: NATIVE_PROTOCOL.devPort }
      : process.env,
  );
const emptyState = (): VmObservation => ({
  messages: [],
  memory: '',
  settings: {
    language: 'zh',
    voice: 'marin',
    model: '',
    notifications: true,
    showWorkSummary: false,
    vm: { host: '', user: 'dant', port: 22, keyPath: '', knownHosts: '' },
  },
  worker: {
    status: ConnectionStatus.Offline,
    account: null,
    models: [],
    realtime: { available: false, reason: 'vm-offline', key: { configured: false } },
  },
  active: null,
  queue: [],
  takeover: false,
  call: null,
  schedules: [],
});

// No Store, Engine, LocalWorker, user command, or authoritative conversation file
// is constructed by this process. The JSON here is explicitly an offline cache.
export function createControllerApp({
  dataDir: selectedDataDir,
  projectRoot: selectedProjectRoot,
  prepareOnly = false,
  bridgeFactory = (options) => new VmBridge(options),
  provisioningFactory = (options) => new Provisioning(options),
  secretFactory = (dir) => createSecretStore(dir),
  profileFactory = (options) => new VmProfiles(options),
  profileOptions = {},
  fontsProvider = listSystemFonts,
  diagnosticsFactory = (options) => new Diagnostics(options),
  updatesFactory = (options) => new UpdateService(options),
  lifecycleFactory = (options) => new VmLifecycle(options),
}: ControllerAppOptions = {}) {
  if (typeof selectedDataDir !== 'string' || typeof selectedProjectRoot !== 'string')
    throw Error('Controller directories are required.');
  const dataDir = selectedDataDir,
    projectRoot = selectedProjectRoot;
  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = path.join(dataDir, 'controller.json'),
    cacheFile = path.join(dataDir, 'state-cache.json');
  const version = serviceVersion(projectRoot),
    diagnostics = diagnosticsFactory({ dataDir, role: 'controller', version }),
    updates = updatesFactory({ version });
  let config: ControllerConfig = {
    language: 'zh',
    notifications: false,
    showWorkSummary: false,
    serviceUpdatesPaused: false,
    ...appearanceDefaults,
  };
  try {
    config = { ...config, ...parse(configFile) };
  } catch {}
  config = {
    ...config,
    ...readAppearance(config),
    language: normalizeLanguage(config.language),
    notifications: config.notifications === true,
    showWorkSummary: config.showWorkSummary === true,
    serviceUpdatesPaused: config.serviceUpdatesPaused === true,
  };
  let cached = emptyState();
  try {
    cached = parse(cacheFile);
  } catch {}
  const profiles = profileFactory({ dataDir, projectRoot, ...profileOptions });
  let profileError: string | null = null;
  try {
    profiles.autoImport();
  } catch (error) {
    profileError = errorMessage(error);
  }
  const bridge = bridgeFactory({ dataDir, projectRoot }),
    provisioning = provisioningFactory({ projectRoot, dataDir }),
    lifecycle = lifecycleFactory({ dataDir, projectRoot });
  let desktop: DesktopLifecycle;
  let manualServiceUpdate: Promise<void> | null = null;
  bridge.reconnectManaged = true;
  const stopBridgeDiagnostics = observeBridge(diagnostics, bridge);
  const notifications = new NotificationHub(dataDir),
    voiceKeys = secretFactory(dataDir);
  notifications.configure(config.notifications);
  const app = express(),
    server = http.createServer(app),
    token = randomBytes(32).toString('hex'),
    wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 }),
    streams = new Set<Response<unknown>>();
  let closing = false,
    lastSaved = 0,
    saveTimer: ReturnType<typeof setTimeout> | null = null;
  app.disable('x-powered-by');
  app.use(observeHttp(diagnostics));
  app.use((req, res, next) => {
    const hostname = req.headers.host?.split(':')[0];
    if (!includesValue(['127.0.0.1', 'localhost'], hostname) || !allowedOrigin(req.headers.origin))
      return res.sendStatus(403);
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dant-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/session', (_req, res) => res.json({ token, product: 'dant', mode: 'controller' }));
  app.use('/api', (req, res, next) =>
    req.headers['x-dant-token'] === token || req.query.token === token
      ? next()
      : res.sendStatus(401),
  );
  app.use('/api/internal', (_req, res) => res.sendStatus(403));
  app.use('/api', (req, res, next) => {
    if (
      desktop?.blocked &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !(
        (req.path === '/connect' && manualConnect) ||
        (req.path === '/service-update' && manualServiceUpdate && req.body?.action === 'install')
      ) &&
      !/^\/api\/(?:desktop\/(?:exit|cancel-exit|open)|updates\/install-lease(?:\/[^/]+)?)$/.test(
        new URL(req.originalUrl, 'http://localhost').pathname,
      )
    )
      return res
        .status(409)
        .json({ error: 'Work is paused for an update or exit.', code: 'desktop_transition_busy' });
    next();
  });
  installUpdateRoutes(app, updates);
  const releasePrepared = () => {
    if (desktop?.phase === DesktopPhase.Paused) desktop.state(DesktopPhase.Idle);
  };
  const updateLease = new UpdateInstallLease({
    snapshot,
    refresh: async () => {
      if (bridge.preparing || manualConnect || manualServiceUpdate)
        throw Object.assign(Error('Update installation has already started.'), { status: 409 });
      if (bridge.refreshing) await bridge.refreshing;
      await desktop.prepare();
      if (bridge.status === ConnectionStatus.Online) await bridge.refresh(true);
    },
    onFailure: releasePrepared,
    onRelease: releasePrepared,
  });
  installLeaseRoutes(app, updateLease);
  app.use('/api', (req, res, next) => {
    if (!updateSensitiveRequest(req)) return next();
    req.updateInstallDone = updateLease.enter();
    res.once('finish', () => req.updateInstallDone?.());
    next();
  });
  const admitted =
    (handler: ControllerHandler) =>
    async (req: ControllerRequest, res: Response<unknown>, next: NextFunction) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        req.updateInstallDone?.(error);
        next(error);
      } finally {
        req.updateInstallDone?.();
      }
    };
  function binding(): VmBinding | { host?: never } {
    try {
      return readVmBinding(dataDir);
    } catch {
      return {};
    }
  }
  desktop = new DesktopLifecycle({
    bridge,
    lifecycle,
    binding,
    onChange: () => broadcast('state', snapshot()),
  });
  let preferenceSync: PreferenceSync | null = null;
  // These idempotent preferences share one writer per SSH/VM connection. A
  // newer UI language waits for any older write before applying its latest value.
  const preferenceFailure = () =>
    Error('The computer connected, but its language and time zone could not be updated.');
  const preferenceValues = () => ({
    language: languageForWorker(config.language, bridge.cached?.capabilities?.languages),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  function preferenceConnection(): PreferenceSync | null {
    const identity = JSON.stringify([bridge.generation ?? null, binding()]);
    if (
      closing ||
      bridge.status !== ConnectionStatus.Online ||
      preferenceSync?.identity !== identity
    ) {
      preferenceSync?.abort.abort();
      preferenceSync = null;
    }
    if (closing || bridge.status !== ConnectionStatus.Online) return null;
    return (preferenceSync ??= {
      identity,
      abort: new AbortController(),
      pending: null,
      confirmed: null,
      submitted: false,
      retryAt: 0,
    });
  }
  const preferenceCurrent = (context: PreferenceSync) =>
    !closing &&
    preferenceSync === context &&
    bridge.status === ConnectionStatus.Online &&
    !context.abort.signal.aborted &&
    context.identity === JSON.stringify([bridge.generation ?? null, binding()]);
  async function syncPreferences({ retry = false }: { retry?: boolean } = {}): Promise<void> {
    const context = preferenceConnection();
    if (!context) return;
    if (context.pending) return context.pending;
    if (!retry && Date.now() < context.retryAt) return;
    const pending = (async () => {
      while (preferenceCurrent(context)) {
        const values = preferenceValues(),
          key = JSON.stringify(values);
        if (context.confirmed === key) return;
        if (
          !context.submitted &&
          observedObject(bridge.cached?.settings).language === values.language &&
          observedObject(bridge.cached?.settings).timeZone === values.timeZone
        ) {
          context.confirmed = key;
          return;
        }
        context.submitted = true;
        const response = await bridge.request('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
          signal: AbortSignal.any([context.abort.signal, AbortSignal.timeout(60000)]),
        });
        if (!preferenceCurrent(context)) return;
        if (!response.ok) throw preferenceFailure();
        context.confirmed = key;
        context.retryAt = 0;
        await bridge.refresh(true);
        if (!preferenceCurrent(context)) return;
      }
    })()
      .catch((error) => {
        if (!preferenceCurrent(context)) return;
        context.confirmed = null;
        context.retryAt = Date.now() + 5000;
        throw error;
      })
      .finally(() => {
        if (context.pending === pending) context.pending = null;
      });
    context.pending = pending;
    return pending;
  }
  function syncPreferencesAfterEvent() {
    const context = preferenceConnection();
    if (!context || context.pending || Date.now() < context.retryAt) return;
    void syncPreferences().catch(() => {
      if (preferenceCurrent(context)) broadcast('notice', { message: preferenceFailure().message });
    });
  }
  async function connect({
    recoverExecutor = false,
    deploy = true,
    automatic = false,
  }: { recoverExecutor?: boolean; deploy?: boolean; automatic?: boolean } = {}) {
    const finish = updateLease.enter();
    let failed;
    try {
      try {
        const discovery = profiles.autoImport();
        if (discovery.requiresSelection)
          throw Object.assign(Error(discovery.error ?? 'Choose an existing VM connection.'), {
            status: 409,
          });
        readVmBinding(dataDir);
        profileError = null;
      } catch (error) {
        profileError = errorMessage(error);
        throw error;
      }
      await bridge.connect({
        deploy,
        updateRunningWork: recoverExecutor,
        ...(automatic ? { autoUpdate: true } : {}),
      });
      await syncPreferences({ retry: true });
      // Reopening SSH after startup or a transport failure must preserve an executor
      // intentionally stopped by voice safety. Only the explicit Reconnect action
      // may start it again, after checking fresh authoritative VM state.
      if (!recoverExecutor) return;
      if (bridge.status !== ConnectionStatus.Online)
        throw Object.assign(
          Error('The VM is still offline. Reconnect before starting its executor.'),
          { status: 503 },
        );
      const state = await bridge.refresh(true);
      if (state?.worker?.status !== ConnectionStatus.Offline) return;
      const computer = observedObject(state.computer);
      if (
        state.active ||
        state.call ||
        state.takeover ||
        state.acquiring ||
        !Array.isArray(state.queue) ||
        state.queue.length ||
        computer?.sessionId ||
        computer?.pending ||
        !includesValue(['dant', 'agent'], computer.status)
      )
        throw Object.assign(
          Error('Stop active work and return computer control before reconnecting the executor.'),
          { status: 409 },
        );
      const response = await bridge.request('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idleRecovery: true }),
      });
      if (!response.ok)
        throw Object.assign(
          Error(
            'The VM connected, but its executor could not reconnect. Check its state before trying again.',
          ),
          { status: response.status >= 400 && response.status < 600 ? response.status : 502 },
        );
      const refreshed = await bridge.refresh(true);
      if (refreshed?.worker?.status !== ConnectionStatus.Online)
        throw Object.assign(
          Error(
            'The VM connected, but its executor is still offline. Check its diagnostics before trying again.',
          ),
          { status: 503 },
        );
    } catch (error) {
      failed = error;
      throw error;
    } finally {
      finish(failed);
    }
  }
  const automaticConnection = new VmServiceUpdateLoop({
    bridge,
    connect,
    binding,
    allowed: () =>
      !closing &&
      !prepareOnly &&
      !manualConnect &&
      !manualServiceUpdate &&
      !desktop.blocked &&
      !config.serviceUpdatesPaused &&
      !!binding().host &&
      !provisioning.snapshot().running &&
      !['preparing', 'creating', 'installing', 'awaiting-admin'].includes(
        provisioning.snapshot().status,
      ),
  });
  function snapshot() {
    const state = structuredClone(cached),
      key = voiceKeys.status();
    const settings = {
      ...observedObject(emptyState().settings),
      ...observedObject(state.settings),
      language: config.language,
      notifications: config.notifications,
      showWorkSummary: config.showWorkSummary,
      ...readAppearance(config),
      vm: { ...observedObject(observedObject(emptyState().settings).vm), ...binding() },
    };
    const worker = {
      ...state.worker,
      status:
        bridge.status === ConnectionStatus.Online
          ? state.worker?.status || ConnectionStatus.Connecting
          : bridge.status,
      error: profileError || bridge.error || state.worker?.error || null,
      realtime: {
        ...observedObject(state.worker?.realtime),
        key,
        api: { available: key.configured, billing: 'api' },
      },
    };
    const controller = {
      status: bridge.status,
      authority: 'vm',
      vmConfigured: !!binding().host,
      updatesPaused: config.serviceUpdatesPaused === true,
      desktopTransition: desktop.phase,
      serviceUpdateBusy: !!manualServiceUpdate,
      cached: bridge.status !== ConnectionStatus.Online,
      updatedAt: lastSaved || null,
      error: profileError || bridge.error || null,
      ...(bridge.serviceUpdate
        ? {
            serviceUpdate: {
              ...bridge.serviceUpdate,
              confirmed:
                bridge.status === ConnectionStatus.Online &&
                bridge.serviceUpdate.confirmed === true,
            },
          }
        : {}),
    };
    return {
      ...state,
      mode: 'vm-controller',
      settings,
      worker,
      provisioning: provisioning.snapshot(),
      controller,
    };
  }
  function broadcast(type: string, data: unknown) {
    if (closing) return;
    const body = JSON.stringify({ type, data });
    for (const client of wss.clients) if (client.readyState === 1) client.send(body);
    for (const stream of streams) stream.write(`data: ${body}\n\n`);
  }
  function saveCache() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const temporary = cacheFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(cached));
    fs.renameSync(temporary, cacheFile);
    lastSaved = Date.now();
  }
  let cachedWorkerStatus = diagnosticWorkerStatus(cached.worker?.status),
    bridgeStatus = diagnosticWorkerStatus(bridge.status);
  diagnostics.log('bridge.status', { status: bridgeStatus });
  diagnostics.log('worker.status', { status: cachedWorkerStatus, cached: true });
  bridge.on('state', (state: VmObservation) => {
    cached = state;
    const status = diagnosticWorkerStatus(state.worker?.status);
    if (status !== cachedWorkerStatus) {
      cachedWorkerStatus = status;
      diagnostics.log('worker.status', { status, cached: true });
    }
    notifications.observe(state);
    if (!saveTimer)
      saveTimer = setTimeout(() => {
        try {
          saveCache();
        } catch {
          broadcast('notice', {
            message: 'The VM state is available, but its Windows cache could not be saved.',
          });
        }
      }, 2000);
    broadcast('state', snapshot());
    syncPreferencesAfterEvent();
    automaticConnection.changed();
  });
  bridge.on('change', () => {
    const status = diagnosticWorkerStatus(bridge.status);
    if (status !== bridgeStatus) {
      bridgeStatus = status;
      diagnostics.log('bridge.status', { status });
    }
    broadcast('state', snapshot());
    syncPreferencesAfterEvent();
    automaticConnection.changed();
  });
  bridge.on('event', (event: unknown) => {
    if (isRecord(event) && typeof event.type === 'string') broadcast(event.type, event.data);
  });
  diagnostics.log('service.started', { version });
  let provisioningStatus = provisioning.snapshot().status;
  provisioning.on('change', (progress: ReturnType<typeof provisioning.snapshot>) => {
    broadcast('state', snapshot());
    if (
      !prepareOnly &&
      progress.status === ProvisioningStatus.Ready &&
      provisioningStatus !== ProvisioningStatus.Ready
    )
      void automaticConnection.start();
    provisioningStatus = progress.status;
  });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (
      url.pathname !== '/events' ||
      url.searchParams.get('token') !== token ||
      !allowedOrigin(req.headers.origin)
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'state', data: snapshot() })));
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    streams.add(res);
    res.write(`data: ${JSON.stringify({ type: 'state', data: snapshot() })}\n\n`);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      streams.delete(res);
    });
  });
  app.get('/api/state', async (_req, res) => {
    if (bridge.status === ConnectionStatus.Online)
      try {
        await bridge.refresh();
      } catch (error) {
        bridge.error = errorMessage(error);
      }
    res.json(snapshot());
  });
  app.get('/api/diagnostics', async (_req, res) => {
    let worker:
      | { available: false; reason: string }
      | { available: true; status: object; recent: unknown[] } = {
      available: false,
      reason: 'worker-unavailable',
    };
    if (bridge.status === ConnectionStatus.Online)
      try {
        const response = await bridge.request('/api/diagnostics');
        if (response.ok) {
          const value: unknown = await response.json();
          if (
            isRecord(value) &&
            value.status !== null &&
            typeof value.status === 'object' &&
            Array.isArray(value.recent)
          )
            worker = { available: true, status: value.status, recent: value.recent.slice(-50) };
        }
      } catch {}
    res.json({ status: diagnostics.status(), recent: diagnostics.recent(50), worker });
  });
  app.all('/api/diagnostics', (_req, res) =>
    res.status(405).json({ error: 'Diagnostics are read-only.' }),
  );
  app.post(
    '/api/provision',
    admitted((req, res) => res.json(provisioning.start(jsonBody(req.body)))),
  );
  let manualConnect: Promise<void> | null = null;
  app.post(
    '/api/connect',
    admitted(async (_req, res) => {
      if (!manualConnect) {
        updateLease.assertQuiescent(1);
        const pending = (async () => {
          await desktop.prepare();
          await connect({ recoverExecutor: true });
        })().finally(() => {
          releasePrepared();
          if (manualConnect === pending) manualConnect = null;
          automaticConnection.changed();
        });
        manualConnect = pending;
      }
      await manualConnect;
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/service-update',
    admitted(async (req, res) => {
      const body = jsonBody(req.body);
      const action = body.action;
      if (
        !includesValue(['pause', 'resume', 'install'], action) ||
        Object.keys(body).some((key) => key !== 'action')
      )
        throw Object.assign(Error('Invalid service update action.'), { status: 400 });
      if (action !== 'install') {
        if (bridge.preparing || manualConnect || manualServiceUpdate)
          throw Object.assign(Error('Update installation has already started.'), { status: 409 });
        config.serviceUpdatesPaused = action === 'pause';
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        if (action === 'resume') automaticConnection.reset();
        broadcast('state', snapshot());
        res.json({ ok: true });
        return;
      }
      if (!manualServiceUpdate) {
        updateLease.assertQuiescent(1);
        const pending = (async () => {
          await desktop.prepare();
          await connect({ recoverExecutor: true });
        })().finally(() => {
          releasePrepared();
          if (manualServiceUpdate === pending) manualServiceUpdate = null;
          automaticConnection.changed();
          broadcast('state', snapshot());
        });
        manualServiceUpdate = pending;
        broadcast('state', snapshot());
      }
      await manualServiceUpdate;
      res.json({ ok: true });
    }),
  );
  app.post('/api/desktop/exit', async (req, res) => {
    if (bridge.preparing || manualConnect || manualServiceUpdate)
      throw Object.assign(Error('Update installation has already started.'), { status: 409 });
    const body = jsonBody(req.body ?? {}),
      reason = body.reason ?? 'exit';
    if (
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !includesValue(['exit', 'install'], reason) ||
      Object.keys(body).some((key) => !['reason', 'leaseId'].includes(key)) ||
      (reason === 'exit' && body.leaseId !== undefined)
    )
      throw Object.assign(Error('Invalid desktop exit request.'), { status: 400 });
    if (reason === 'install') updateLease.pin(body.leaseId);
    else updateLease.assertQuiescent();
    try {
      const result = await desktop.exit();
      res.json({ ...result, ...(reason === 'install' ? updateLease.renew(body.leaseId) : {}) });
    } catch (error) {
      if (reason === 'install')
        try {
          updateLease.release(body.leaseId);
        } catch {}
      throw error;
    }
  });
  app.post('/api/desktop/cancel-exit', async (req, res) => {
    const body = jsonBody(req.body ?? {});
    if (
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['reason', 'leaseId'].includes(key)) ||
      (body.reason !== undefined && !includesValue(['exit', 'install'], body.reason))
    )
      throw Object.assign(Error('Invalid desktop exit cancellation.'), { status: 400 });
    const lease = updateLease.current();
    if (
      lease
        ? body.leaseId !== lease.leaseId || body.reason !== 'install'
        : body.leaseId !== undefined
    )
      throw Object.assign(Error('The installation lease changed.'), { status: 409 });
    const result = await desktop.cancel();
    if (body.leaseId && updateLease.current()) updateLease.release(body.leaseId);
    automaticConnection.changed();
    res.json(result);
  });
  app.post('/api/desktop/open', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
      throw Object.assign(Error('An empty desktop open request is required.'), { status: 400 });
    if (bridge.preparing || manualConnect || manualServiceUpdate)
      throw Object.assign(Error('Update installation has already started.'), { status: 409 });
    updateLease.assertQuiescent();
    if (desktop.blocked || bridge.status !== ConnectionStatus.Online) {
      await desktop.cancel();
      if (!prepareOnly && binding().host && !provisioning.snapshot().running)
        await automaticConnection.start();
    }
    res.json({ ok: true });
  });
  app.post(
    '/api/prepare',
    admitted(async (_req, res) => {
      await bridge.prepare();
      res.json({ ok: true });
    }),
  );
  app.get('/api/vm/profiles', (_req, res) => res.json(profiles.discover()));
  app.get('/api/vm/providers', (_req, res) => res.json(provisioning.providers()));
  app.get('/api/fonts', async (_req, res) => res.json(await fontsProvider()));
  app.post(
    '/api/vm/import',
    admitted((req, res) => {
      const previous = profiles.discover().current,
        result = profiles.import(jsonBody(req.body));
      profileError = null;
      if (previous?.id !== profiles.discover().current?.id) {
        bridge.disconnect();
        automaticConnection.reset();
      }
      broadcast('state', snapshot());
      res.json(result);
    }),
  );
  app.get('/api/notifications/pending', (_req, res) =>
    res.json({
      notifications: notifications
        .pending()
        .map((notification) => ({ ...notification, language: config.language })),
    }),
  );
  app.post('/api/notifications/:id/ack', (req, res) =>
    res.json(notifications.acknowledge(req.params.id)),
  );
  app.post('/api/voice-key', async (req, res) => {
    if (cached.call) throw Error('End the call before changing its API key');
    await voiceKeys.set(jsonBody(req.body).key);
    broadcast('state', snapshot());
    res.json({ ok: true, key: voiceKeys.status() });
  });
  app.delete('/api/voice-key', async (_req, res) => {
    if (cached.call) throw Error('End the call before removing its API key');
    await voiceKeys.clear();
    broadcast('state', snapshot());
    res.json({ ok: true, key: voiceKeys.status() });
  });
  app.post('/api/call', async (req, _res, next) => {
    if (jsonBody(req.body).provider === 'api') {
      const key = await voiceKeys.get();
      if (!key) throw Error('Configure the optional voice API key first');
      req.body = { ...jsonBody(req.body), apiKey: key };
    }
    next();
  });
  app.patch('/api/settings', async (req, res, next) => {
    const body = { ...jsonBody(req.body) };
    if (
      body.vm &&
      (cached.active ||
        cached.call ||
        cached.takeover ||
        includesValue(
          [ComputerControlStatus.Human, ComputerControlStatus.TakingOver],
          observedObject(cached.computer).status,
        ))
    )
      throw Object.assign(
        Error('Stop active work and return computer control before changing its connection'),
        { status: 409 },
      );
    const appearance = validateAppearancePatch(body);
    for (const key of ['language', 'notifications', 'showWorkSummary'])
      if (body[key] !== undefined) {
        if (key === 'language' && !isLanguage(body[key])) throw Error('Invalid language');
        if (key === 'notifications' && typeof body[key] !== 'boolean')
          throw Error('Invalid notification preference');
        if (key === 'showWorkSummary' && typeof body[key] !== 'boolean')
          throw Error('Invalid work summary preference');
      }
    if (body.vm) {
      const vmPatch = jsonBody(body.vm);
      const old = binding(),
        vm = normalizeVmBinding(
          {
            ...old,
            ...Object.fromEntries(
              ['host', 'user', 'port', 'keyPath', 'knownHosts']
                .filter((key) => vmPatch[key] !== undefined)
                .map((key) => [key, vmPatch[key]]),
            ),
          },
          dataDir,
        ),
        temporary = path.join(dataDir, `.vm-settings-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(vm, null, 2), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, path.join(dataDir, 'vm.json'));
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      try {
        profiles.registerCurrent();
      } catch {}
      profileError = null;
      bridge.disconnect();
      automaticConnection.reset();
      delete body.vm;
    }
    Object.assign(config, appearance);
    for (const key of appearanceKeys) delete body[key];
    for (const key of ['language', 'notifications', 'showWorkSummary'])
      if (body[key] !== undefined) {
        if (key === 'language' && isLanguage(body[key])) config.language = body[key];
        else if (key === 'notifications' && typeof body[key] === 'boolean')
          config.notifications = body[key];
        else if (key === 'showWorkSummary' && typeof body[key] === 'boolean')
          config.showWorkSummary = body[key];
        if (key !== 'language' || bridge.status !== ConnectionStatus.Online) delete body[key];
      }
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    notifications.configure(config.notifications);
    broadcast('state', snapshot());
    const forwardingScope = JSON.stringify([bridge.generation ?? null, binding()]);
    if (body.language !== undefined) {
      delete body.language;
      await syncPreferences({ retry: true });
    }
    if (Object.keys(body).length) {
      if (closing || forwardingScope !== JSON.stringify([bridge.generation ?? null, binding()]))
        throw Object.assign(
          Error('The VM connection changed before its settings could be updated.'),
          { status: 409 },
        );
      req.body = body;
      return next();
    }
    res.json({ ok: true });
  });
  app.use('/api', async (req, res, next) => {
    let failed;
    try {
      const route = new URL(req.originalUrl, 'http://localhost');
      route.searchParams.delete('token');
      if (
        req.method === 'POST' &&
        route.pathname === '/api/messages' &&
        Object.hasOwn(req.body ?? {}, 'workReply')
      ) {
        const scope = JSON.stringify([bridge.generation ?? null, binding()]);
        if (bridge.status !== ConnectionStatus.Online)
          throw Object.assign(Error('Reconnect before replying to this task.'), { status: 409 });
        const current = await bridge.refresh(true);
        if (
          closing ||
          bridge.status !== ConnectionStatus.Online ||
          scope !== JSON.stringify([bridge.generation ?? null, binding()]) ||
          current?.capabilities?.workReply !== true
        )
          throw Object.assign(
            Error('Update the work computer service before replying to a task.'),
            { status: 409, code: 'service_update_required' },
          );
      }
      const scheduleId = /^\/api\/schedules\/([^/]+)$/.exec(route.pathname)?.[1],
        knownSchedule = scheduleId
          ? (Array.isArray(cached.schedules) ? cached.schedules : []).find(
              (item: unknown) => isRecord(item) && item.id === decodeURIComponent(scheduleId),
            )
          : null;
      if (
        ['POST', 'PATCH', 'DELETE'].includes(req.method) &&
        /^\/api\/schedules(?:\/[^/]+)?$/.test(route.pathname) &&
        (['cron', 'priority'].some((key) => Object.hasOwn(req.body ?? {}, key)) ||
          knownSchedule?.cron ||
          (knownSchedule?.priority && knownSchedule.priority !== TaskPriority.Normal))
      ) {
        const scope = JSON.stringify([bridge.generation ?? null, binding()]);
        if (bridge.status !== ConnectionStatus.Online)
          throw Object.assign(Error('Reconnect before changing this scheduled task.'), {
            status: 409,
          });
        const current = await bridge.refresh(true);
        if (
          closing ||
          bridge.status !== ConnectionStatus.Online ||
          scope !== JSON.stringify([bridge.generation ?? null, binding()]) ||
          current?.capabilities?.recurringSchedules !== true
        )
          throw Object.assign(
            Error(
              'Update the work computer service before using recurring schedules and priorities.',
            ),
            { status: 409, code: 'service_update_required' },
          );
      }
      const headers: Record<string, string> = {};
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      const options: VmRequestOptions = { method: req.method, headers };
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.is('application/json')) options.body = JSON.stringify(req.body ?? {});
        else {
          options.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
          options.duplex = 'half';
        }
      }
      const response = await bridge.request(route.pathname + route.search, options);
      res.status(response.status);
      for (const name of [
        'content-type',
        'content-disposition',
        'cache-control',
        'x-content-type-options',
      ])
        if (response.headers.has(name)) res.setHeader(name, response.headers.get(name) ?? '');
      if (response.body)
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
          .on('error', (error) => {
            if (!res.headersSent) next(error);
            else res.destroy();
          })
          .pipe(res);
      else res.end();
    } catch (error) {
      failed = error;
      next(error);
    } finally {
      req.updateInstallDone?.(failed);
    }
  });
  app.use(express.static(path.join(projectRoot, 'dist')));
  const handleError: ErrorRequestHandler = (error: unknown, req, res, next) => {
    req.updateInstallDone?.(error);
    if (res.headersSent) return next(error);
    const details = observedObject(error);
    res.status(typeof details.status === 'number' ? details.status : 400).json({
      error: errorMessage(error),
      ...(typeof details.code === 'string' && /^[a-z_]{1,64}$/.test(details.code)
        ? { code: details.code }
        : {}),
      ...(details.unknownOutcome ? { unknownOutcome: true } : {}),
    });
  };
  app.use(handleError);
  let closePromise: Promise<void> | undefined;
  return {
    app,
    server,
    bridge,
    provisioning,
    profiles,
    notifications,
    voiceKeys,
    diagnostics,
    updates,
    lifecycle,
    desktop,
    snapshot,
    start: async () => {
      await lifecycle.resume();
      const progress = provisioning.resumeMonitoring();
      if (
        !prepareOnly &&
        binding().host &&
        !progress.running &&
        !['preparing', 'creating', 'installing', 'awaiting-admin'].includes(progress.status)
      )
        await automaticConnection.start();
    },
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      desktop.close();
      automaticConnection.close();
      stopBridgeDiagnostics();
      preferenceSync?.abort.abort();
      preferenceSync = null;
      updateLease.close();
      updates.close();
      if (saveTimer) clearTimeout(saveTimer);
      try {
        if (bridge.cached) saveCache();
      } catch {}
      bridge.close();
      provisioning.close();
      for (const stream of streams) stream.end();
      streams.clear();
      for (const client of wss.clients) client.terminate();
      wss.close();
      closePromise = new Promise<void>((resolve, reject) => {
        if (server.listening) server.close((error) => (error ? reject(error) : resolve()));
        else resolve();
      }).finally(() => {
        diagnostics.log('service.closed', { version });
        diagnostics.close();
      });
      return closePromise;
    },
  };
}
