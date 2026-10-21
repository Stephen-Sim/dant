export const MAX_PORT = 65_535;
const MAX_PROTOCOL_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 128;
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost']);
const PROTOCOL_KEYS = [
  'loopbackHost',
  'loopbackHosts',
  'apiPort',
  'devPort',
  'guestPort',
  'bootstrapGuestPort',
  'paths',
];
const PATH_KEYS = [
  'api',
  'events',
  'session',
  'version',
  'state',
  'health',
  'screen',
  'input',
  'control',
  'file',
  'readFile',
] as const;
type PathKey = (typeof PATH_KEYS)[number];
export interface Protocol {
  readonly loopbackHost: '127.0.0.1';
  readonly loopbackHosts: readonly string[];
  readonly apiPort: number;
  readonly devPort: number;
  readonly guestPort: number;
  readonly bootstrapGuestPort: number;
  readonly paths: Readonly<Record<PathKey, string>>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function requireProtocol(value: unknown): asserts value {
  if (!value) throw Error('Invalid canonical network protocol.');
}
const keysMatch = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function validateProtocol(input: unknown): Protocol {
  requireProtocol(object(input) && keysMatch(input, PROTOCOL_KEYS));
  requireProtocol(input.loopbackHost === '127.0.0.1');
  const hosts = input.loopbackHosts;
  requireProtocol(
    Array.isArray(hosts) &&
      hosts.length === LOOPBACK_HOSTS.length &&
      new Set(hosts).size === hosts.length &&
      hosts.every((host: unknown) => typeof host === 'string' && LOOPBACK_HOSTS.includes(host)),
  );
  const ports = [input.apiPort, input.devPort, input.guestPort, input.bootstrapGuestPort];
  requireProtocol(
    ports.every(
      (port) =>
        typeof port === 'number' && Number.isSafeInteger(port) && port > 0 && port <= MAX_PORT,
    ) && new Set(ports).size === ports.length,
  );
  const paths = input.paths;
  requireProtocol(object(paths) && keysMatch(paths, PATH_KEYS));
  const pathEntries = PATH_KEYS.map((key) => {
    const value = paths[key];
    requireProtocol(
      typeof value === 'string' &&
        value.length >= 2 &&
        value.length <= MAX_PATH_LENGTH &&
        /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value),
    );
    return [key, value] as const;
  });
  const pathMap = Object.fromEntries(pathEntries);
  requireProtocol(new Set(pathEntries.map(([, value]) => value)).size === PATH_KEYS.length);
  for (const key of ['session', 'version', 'state'])
    requireProtocol(pathMap[key]?.startsWith(pathMap.api + '/'));
  // Every required key was validated above; construct the named contract explicitly.
  const pathValue = (key: PathKey): string => {
    const value = pathMap[key];
    requireProtocol(typeof value === 'string');
    return value;
  };
  const portValue = (key: 'apiPort' | 'devPort' | 'guestPort' | 'bootstrapGuestPort'): number => {
    const value = input[key];
    requireProtocol(typeof value === 'number');
    return value;
  };
  return Object.freeze({
    loopbackHost: input.loopbackHost,
    loopbackHosts: Object.freeze([...LOOPBACK_HOSTS]),
    apiPort: portValue('apiPort'),
    devPort: portValue('devPort'),
    guestPort: portValue('guestPort'),
    bootstrapGuestPort: portValue('bootstrapGuestPort'),
    paths: Object.freeze({
      api: pathValue('api'),
      events: pathValue('events'),
      session: pathValue('session'),
      version: pathValue('version'),
      state: pathValue('state'),
      health: pathValue('health'),
      screen: pathValue('screen'),
      input: pathValue('input'),
      control: pathValue('control'),
      file: pathValue('file'),
      readFile: pathValue('readFile'),
    }),
  });
}

/** JSON syntax is checked first; structural tokens then retain duplicate object keys. */
export function parseProtocolJSON(text: string): Protocol {
  requireProtocol(new TextEncoder().encode(text).byteLength <= MAX_PROTOCOL_BYTES);
  const value: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g) ?? [];
  const containers: (Set<string> | null)[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token === '{') containers.push(new Set());
    else if (token === '[') containers.push(null);
    else if (token === '}' || token === ']') containers.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ':') {
      const key: unknown = JSON.parse(token);
      const current = containers.at(-1);
      requireProtocol(typeof key === 'string' && current && !current.has(key));
      current.add(key);
    }
  }
  return validateProtocol(value);
}
