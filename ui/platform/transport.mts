// The renderer speaks the same local JSON contract through IPC or HTTP.
// No credentials, application state, or drafts are persisted here.
import { isRecord, LocalRequestError, requestError } from '../shared/contracts.mts';
import type { ApiOptions, Timer } from '../shared/contracts.mts';
const EVENT_RECONNECT_DELAY_MS = 2_000;
const STATE_POLL_DELAY_MS = 700;
const INDEPENDENT_READ_ROUTES = Object.freeze([
  '/api/session',
  '/api/controller/settings',
  '/api/version',
  '/api/updates',
  '/api/updates?channel=beta',
]);
export interface TransportEvent {
  type: string;
  data: unknown;
}
export interface NativeApiRequest {
  route: string;
  method: string;
  body: string | null;
  token: string;
}
export type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type NativeApiInvoke = (command: 'api_request', args: NativeApiRequest) => Promise<unknown>;
type SourceApi = Pick<EventSource, 'onopen' | 'onmessage' | 'onerror' | 'close'> & {
  addEventListener(
    type: 'state' | 'notice' | 'realtime',
    listener: (event: MessageEvent) => void,
  ): void;
};
type SocketApi = Pick<WebSocket, 'onopen' | 'onmessage' | 'onerror' | 'onclose' | 'close'>;
interface TransportOptions {
  base?: string;
  desktop?: boolean;
  onToken?: (token: string) => void;
  invokeRequest?: NativeApiInvoke;
  fetchRequest?: (url: string, options: RequestInit) => Promise<Pick<Response, 'status' | 'text'>>;
  EventSourceImpl?: new (url: string) => SourceApi;
  WebSocketImpl?: new (url: string) => SocketApi;
  origin?: string;
  pollDelay?: number;
}
export function createTransport({
  base = '',
  desktop = Boolean(globalThis.window?.__TAURI_INTERNALS__),
  onToken = () => {},
  invokeRequest,
  fetchRequest = fetch,
  EventSourceImpl = globalThis.EventSource,
  WebSocketImpl = globalThis.WebSocket,
  origin = globalThis.location?.origin || '',
  pollDelay = STATE_POLL_DELAY_MS,
}: TransportOptions = {}) {
  let token = '',
    ipc: Promise<unknown> = Promise.resolve(),
    generation = 0;
  let source: SourceApi | null = null,
    socket: SocketApi | null = null,
    retryTimer: Timer | undefined,
    cancelDelay: (() => void) | null = null;
  const setToken = (value: unknown) => {
    token = String(value || '');
    onToken(token);
  };
  const parse = (status: number, body: string): unknown => {
    let result: unknown;
    try {
      result = body ? JSON.parse(body) : {};
    } catch {
      if (status >= 200 && status < 300)
        throw new Error('Invalid JSON response from local service');
      result = {};
    }
    if (status < 200 || status >= 300) {
      const error = new LocalRequestError(
        isRecord(result) && typeof result.error === 'string'
          ? result.error
          : `Request failed (${status})`,
      );
      error.status = status;
      if (isRecord(result) && typeof result.code === 'string' && /^[a-z_]{1,64}$/.test(result.code))
        error.code = result.code;
      error.unknownOutcome = isRecord(result) && result.unknownOutcome === true;
      throw error;
    }
    return result;
  };
  function json(
    route: string,
    { method = 'GET', body, headers = {}, keepalive = false }: ApiOptions = {},
  ): Promise<unknown> {
    if (
      !route.startsWith('/api/') ||
      route.includes('://') ||
      route.includes('\\') ||
      route.split('/').includes('..')
    )
      return Promise.reject(new Error('Invalid local API route'));
    const encoded = body === undefined || body === null ? null : JSON.stringify(body);
    const requestOnce = async () => {
      if (desktop) {
        const invoke = invokeRequest || (await import('@tauri-apps/api/core')).invoke;
        const response = await invoke('api_request', { route, method, body: encoded, token });
        if (
          !isRecord(response) ||
          typeof response.status !== 'number' ||
          typeof response.body !== 'string'
        )
          throw Error('Invalid response from native local service');
        return parse(response.status, response.body);
      }
      const response = await fetchRequest(base + route, {
        method,
        headers: {
          'X-Dant-Token': token,
          ...(encoded === null ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(encoded === null ? {} : { body: encoded }),
        keepalive,
      });
      return parse(response.status, await response.text());
    };
    const perform = async () => {
      try {
        return await requestOnce();
      } catch (cause) {
        const error = requestError(cause);
        if (!['GET', 'HEAD'].includes(method) && error.status === undefined)
          error.unknownOutcome = true;
        throw error;
      }
    };
    // Local recovery reads must remain reachable while a VM connection is pending.
    // Public-release reads can wait on GitHub. Neither belongs in the native
    // mutation queue; both still use the same authenticated native bridge.
    if (
      !desktop ||
      (method === 'GET' && INDEPENDENT_READ_ROUTES.includes(route)) ||
      (method === 'POST' && route === '/api/skills/import/preview')
    )
      return perform();
    const request = ipc.then(perform, perform);
    ipc = request.catch(() => {});
    return request;
  }
  const refreshToken = async () => {
    const session = await json('/api/session');
    if (!isRecord(session) || typeof session.token !== 'string')
      throw Error('Invalid local service session');
    setToken(session.token);
  };
  function stopEvents() {
    generation++;
    clearTimeout(retryTimer);
    cancelDelay?.();
    cancelDelay = null;
    source?.close();
    source = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
      socket = null;
    }
  }
  function startEvents({
    onEvent,
    onConnection = () => {},
  }: {
    onEvent: (event: TransportEvent) => unknown;
    onConnection?: (connected: boolean, error?: unknown) => void;
  }) {
    stopEvents();
    const run = generation;
    const current = () => generation === run;
    const deliver = (event: TransportEvent) => {
      if (!current()) return;
      Promise.resolve(onEvent(event)).catch(() => {});
    };
    const receive = (raw: unknown, type?: string) => {
      try {
        if (typeof raw !== 'string') return;
        const parsed: unknown = JSON.parse(raw);
        deliver(
          isRecord(parsed) && typeof parsed.type === 'string' && 'data' in parsed
            ? { type: parsed.type, data: parsed.data }
            : { type: type || 'state', data: parsed },
        );
      } catch {
        /* Ignore malformed events; the next state remains authoritative. */
      }
    };
    const reconnect = () => {
      if (!current()) return;
      onConnection(false);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(async () => {
        if (!current()) return;
        try {
          await refreshToken();
        } catch {
          reconnect();
          return;
        }
        if (current()) connectSSE();
      }, EVENT_RECONNECT_DELAY_MS);
    };
    const connectWS = () => {
      if (!current()) return;
      if (!WebSocketImpl) {
        reconnect();
        return;
      }
      let connection;
      try {
        connection = new WebSocketImpl(
          (base || origin).replace(/^http/, 'ws') + '/events?token=' + encodeURIComponent(token),
        );
      } catch {
        reconnect();
        return;
      }
      socket = connection;
      connection.onopen = () => {
        if (current() && socket === connection) onConnection(true);
      };
      connection.onmessage = (event) => {
        if (socket === connection) receive(event.data);
      };
      connection.onclose = () => {
        if (socket === connection) {
          socket = null;
          reconnect();
        }
      };
      connection.onerror = () => connection.close();
    };
    const connectSSE = () => {
      if (!current()) return;
      if (!EventSourceImpl) {
        connectWS();
        return;
      }
      let connection;
      try {
        connection = new EventSourceImpl(base + '/api/events?token=' + encodeURIComponent(token));
      } catch {
        connectWS();
        return;
      }
      source = connection;
      connection.onopen = () => {
        if (current() && source === connection) onConnection(true);
      };
      connection.onmessage = (event) => {
        if (source === connection) receive(event.data);
      };
      for (const type of ['state', 'notice', 'realtime'] as const)
        connection.addEventListener(type, (event) => {
          if (source === connection && 'data' in event) receive(event.data, type);
        });
      connection.onerror = () => {
        if (!current() || source !== connection) return;
        connection.close();
        source = null;
        onConnection(false);
        connectWS();
      };
    };
    if (desktop) {
      const poll = async () => {
        while (current()) {
          try {
            const data = await json('/api/state');
            if (!current()) break;
            onConnection(true);
            await onEvent({ type: 'state', data });
          } catch (cause) {
            const error = requestError(cause);
            if (!current()) break;
            onConnection(false, error);
            if (error.status === 401) await refreshToken().catch(() => {});
          }
          if (!current()) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              cancelDelay = null;
              resolve();
            }, pollDelay);
            cancelDelay = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
      };
      poll().catch(() => {
        if (current()) onConnection(false);
      });
    } else connectSSE();
    return stopEvents;
  }
  return { json, setToken, startEvents, stopEvents, close: stopEvents };
}
