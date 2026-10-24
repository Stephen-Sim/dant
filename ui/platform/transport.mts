import { NATIVE_PROTOCOL, apiPath } from './native-protocol.mts';
// The renderer speaks the same local JSON contract through IPC or HTTP.
// No credentials, application state, or drafts are persisted here.
import { isRecord, LocalRequestError, requestError } from '../shared/contracts.mts';
import type { ApiOptions, Timer } from '../shared/contracts.mts';
const EVENT_RECONNECT_DELAY_MS = 2_000;
const STATE_POLL_DELAY_MS = 700;
const REQUEST_SCOPE_CHANGED_CODE = 'request_scope_changed';
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
    chatIpc: Promise<unknown> = Promise.resolve(),
    mutationRevision = 0,
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
    { method = 'GET', body, headers = {}, keepalive = false, beforeSend }: ApiOptions = {},
  ): Promise<unknown> {
    if (
      !route.startsWith(NATIVE_PROTOCOL.paths.api + '/') ||
      route.includes('://') ||
      route.includes('\\') ||
      route.split('/').includes('..')
    )
      return Promise.reject(new Error('Invalid local API route'));
    const encoded = body === undefined || body === null ? null : JSON.stringify(body);
    const guardedChatSubmission =
      method === 'POST' &&
      (route === apiPath('/messages') || route === apiPath('/realtime/message')) &&
      typeof beforeSend === 'function';
    let guardedRevision = mutationRevision;
    const checkBeforeSend = () => {
      if (!beforeSend) return;
      let valid = false;
      try {
        valid =
          (!desktop || guardedChatSubmission || guardedRevision === mutationRevision) &&
          beforeSend() === true;
      } catch {
        // A failed precondition cannot authorize crossing the native boundary.
      }
      if (!valid) {
        const error = new LocalRequestError(
          'The request was not sent because its target changed. Open it again.',
        );
        error.status = 409;
        error.code = REQUEST_SCOPE_CHANGED_CODE;
        throw error;
      }
    };
    const requestOnce = async () => {
      if (desktop) {
        const invoke = invokeRequest || (await import('@tauri-apps/api/core')).invoke;
        checkBeforeSend();
        const response = await invoke('api_request', { route, method, body: encoded, token });
        if (
          !isRecord(response) ||
          typeof response.status !== 'number' ||
          typeof response.body !== 'string'
        )
          throw Error('Invalid response from native local service');
        return parse(response.status, response.body);
      }
      checkBeforeSend();
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
    // Reads never hold up controls or wait behind long connection/backup work.
    // Control writes retain their order. Captured chat submissions have their own
    // ordered lane so connection/input work cannot delay outgoing chat. Every lane
    // crosses the same authenticated native bridge; mutations are never retried.
    if (
      !desktop ||
      method === 'GET' ||
      (method === 'POST' && route === apiPath('/skills/import/preview'))
    )
      return perform();
    mutationRevision++;
    // A guarded write must not silently follow a connection-changing write
    // before the renderer has observed its new state. Only opted-in requests
    // fail closed when another mutation enters or leaves this ordered lane.
    guardedRevision++;
    const mutate = async () => {
      try {
        return await perform();
      } finally {
        mutationRevision++;
      }
    };
    const request = (guardedChatSubmission ? chatIpc : ipc).then(mutate, mutate);
    if (guardedChatSubmission)
      chatIpc = request.then(
        () => undefined,
        () => undefined,
      );
    else
      ipc = request.then(
        () => undefined,
        () => undefined,
      );
    return request;
  }
  const refreshToken = async () => {
    const session = await json(NATIVE_PROTOCOL.paths.session);
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
          (base || origin).replace(/^http/, 'ws') +
            NATIVE_PROTOCOL.paths.events +
            '?token=' +
            encodeURIComponent(token),
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
        connection = new EventSourceImpl(
          base +
            NATIVE_PROTOCOL.paths.api +
            NATIVE_PROTOCOL.paths.events +
            '?token=' +
            encodeURIComponent(token),
        );
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
      let lastState: string | undefined;
      const poll = async () => {
        while (current()) {
          try {
            const revision = mutationRevision;
            const data = await json(NATIVE_PROTOCOL.paths.state);
            if (!current()) break;
            // A snapshot started before a submitted/completed mutation cannot
            // replace its newer state. Poll again; never replay the mutation.
            if (revision !== mutationRevision) {
              lastState = undefined;
              continue;
            }
            onConnection(true);
            const serialized = JSON.stringify(data);
            if (serialized !== lastState) {
              await onEvent({ type: 'state', data });
              lastState = serialized;
            }
          } catch (cause) {
            const error = requestError(cause);
            if (!current()) break;
            lastState = undefined;
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
