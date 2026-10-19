// The renderer speaks the same local JSON contract through IPC or HTTP.
// No credentials, application state, or drafts are persisted here.
export function createTransport({
  base = '',
  desktop = Boolean(globalThis.window?.__TAURI_INTERNALS__),
  onToken = () => {},
  invokeRequest,
  fetchRequest = (...args) => fetch(...args),
  EventSourceImpl = globalThis.EventSource,
  WebSocketImpl = globalThis.WebSocket,
  origin = globalThis.location?.origin || '',
  pollDelay = 700,
} = {}) {
  let token = '',
    ipc = Promise.resolve(),
    generation = 0;
  let source, socket, retryTimer, cancelDelay;
  const setToken = (value) => {
    token = String(value || '');
    onToken(token);
  };
  const parse = (status, body) => {
    let result;
    try {
      result = body ? JSON.parse(body) : {};
    } catch {
      if (status >= 200 && status < 300)
        throw new Error('Invalid JSON response from local service');
      result = {};
    }
    if (status < 200 || status >= 300) {
      const error = new Error(
        typeof result.error === 'string' ? result.error : `Request failed (${status})`,
      );
      error.status = status;
      if (typeof result.code === 'string' && /^[a-z_]{1,64}$/.test(result.code))
        error.code = result.code;
      error.unknownOutcome = result.unknownOutcome === true;
      throw error;
    }
    return result;
  };
  function json(route, { method = 'GET', body, headers = {}, keepalive = false } = {}) {
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
        const error =
          cause instanceof Error
            ? cause
            : new Error(typeof cause === 'string' ? cause : 'Local API request failed');
        if (!['GET', 'HEAD'].includes(method) && error.status === undefined)
          error.unknownOutcome = true;
        throw error;
      }
    };
    // Public-release lookups are independent reads and may wait on GitHub.
    // Keep them outside the native work queue so they cannot delay hangup,
    // input ownership changes or the next authoritative state poll.
    if (
      !desktop ||
      (method === 'GET' &&
        ['/api/version', '/api/updates', '/api/updates?channel=beta'].includes(route)) ||
      (method === 'POST' && route === '/api/skills/import/preview')
    )
      return perform();
    const request = ipc.then(perform, perform);
    ipc = request.catch(() => {});
    return request;
  }
  const refreshToken = async () => {
    const session = await json('/api/session');
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
  function startEvents({ onEvent, onConnection = () => {} }) {
    stopEvents();
    const run = generation;
    const current = () => generation === run;
    const deliver = (event) => {
      if (!current()) return;
      Promise.resolve(onEvent(event)).catch(() => {});
    };
    const receive = (raw, type) => {
      try {
        const parsed = JSON.parse(raw);
        deliver(
          parsed && typeof parsed.type === 'string' && 'data' in parsed
            ? parsed
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
      }, 2000);
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
      for (const type of ['state', 'notice', 'realtime'])
        connection.addEventListener(type, (event) => {
          if (source === connection) receive(event.data, type);
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
          } catch (error) {
            if (!current()) break;
            onConnection(false, error);
            if (error.status === 401) await refreshToken().catch(() => {});
          }
          if (!current()) break;
          await new Promise((resolve) => {
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
