import protocol from './protocol.json' with { type: 'json' };

export const MAX_PORT = 65_535;
// Includes JSON escaping and metadata around bounded skill file contents.
export const API_JSON_BODY_BYTES = 3 * 1024 * 1024;

// Environment and transport values are untrusted until their field validators
// have accepted them. This also accepts process.env without widening to any.
export type ConfigurationEnvironment = Readonly<Record<string, unknown>>;

export interface NetworkEndpoint {
  readonly host: string;
  readonly port: number;
  readonly httpOrigin: string;
  readonly wsOrigin: string;
}

export interface NetworkConfig {
  readonly api: NetworkEndpoint;
  readonly development: NetworkEndpoint;
  readonly guest: NetworkEndpoint;
}

export interface NativeProtocol extends NetworkEndpoint {
  readonly devPort: number;
}

export interface ApplicationEndpointOptions {
  readonly vmWorker?: boolean;
}

export interface PublicVmEnvironment {
  readonly DANT_GUEST_HOST: string;
  readonly DANT_GUEST_PORT: string;
}

export const NETWORK_DEFAULTS = Object.freeze({
  host: protocol.loopbackHost,
  apiPort: protocol.apiPort,
  devPort: protocol.devPort,
  guestPort: protocol.guestPort,
});
export const PROTOCOL_PATHS = Object.freeze({ ...protocol.paths });

// These addresses/ports are a native IPC protocol, not user preferences.
export const NATIVE_PROTOCOL: NativeProtocol = Object.freeze({
  host: protocol.loopbackHost,
  port: protocol.apiPort,
  httpOrigin: `http://${protocol.loopbackHost}:${protocol.apiPort}`,
  wsOrigin: `ws://${protocol.loopbackHost}:${protocol.apiPort}`,
  devPort: protocol.devPort,
});

export function configPort(value: unknown, name: string, fallback: number): number {
  const selected = value === undefined || value === '' ? fallback : value;
  if (
    (typeof selected !== 'number' || !Number.isInteger(selected)) &&
    (typeof selected !== 'string' || !/^[1-9][0-9]{0,4}$/.test(selected))
  ) {
    throw Error(`${name} must be an integer from 1 to 65535.`);
  }
  const port = Number(selected);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw Error(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

export function configLoopback(
  value: unknown,
  name: string,
  fallback: string = NETWORK_DEFAULTS.host,
): string {
  const host = value === undefined || value === '' ? fallback : value;
  if (typeof host !== 'string' || !protocol.loopbackHosts.includes(host)) {
    throw Error(`${name} must be 127.0.0.1 or localhost.`);
  }
  return host;
}

function endpoint(host: string, port: number): NetworkEndpoint {
  return Object.freeze({
    host,
    port,
    httpOrigin: `http://${host}:${port}`,
    wsOrigin: `ws://${host}:${port}`,
  });
}

export function readNetworkConfig(env: ConfigurationEnvironment = process.env): NetworkConfig {
  const host = configLoopback(env.DANT_HOST, 'DANT_HOST');
  return Object.freeze({
    api: endpoint(host, configPort(env.DANT_PORT, 'DANT_PORT', NETWORK_DEFAULTS.apiPort)),
    development: endpoint(
      host,
      configPort(env.DANT_DEV_PORT, 'DANT_DEV_PORT', NETWORK_DEFAULTS.devPort),
    ),
    guest: endpoint(
      configLoopback(env.DANT_GUEST_HOST, 'DANT_GUEST_HOST'),
      configPort(env.DANT_GUEST_PORT, 'DANT_GUEST_PORT', NETWORK_DEFAULTS.guestPort),
    ),
  });
}

export function applicationEndpoint(
  env: ConfigurationEnvironment = process.env,
  { vmWorker = false }: ApplicationEndpointOptions = {},
): NetworkEndpoint {
  // Native host IPC and the SSH-forwarded authoritative worker share a fixed
  // protocol. DANT_PORT is only a local development server option.
  return env.DANT_MANAGED || vmWorker ? NATIVE_PROTOCOL : readNetworkConfig(env).api;
}

// The deployment archive may contain only these public configuration values.
// In particular, never serialize process.env or copy the host's .env into a VM.
export function publicVmEnvironment(
  env: ConfigurationEnvironment = process.env,
): PublicVmEnvironment {
  return Object.freeze({
    DANT_GUEST_HOST: configLoopback(env.DANT_GUEST_HOST, 'DANT_GUEST_HOST'),
    DANT_GUEST_PORT: String(
      configPort(env.DANT_GUEST_PORT, 'DANT_GUEST_PORT', NETWORK_DEFAULTS.guestPort),
    ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validatePublicVmEnvironment(value: unknown): PublicVmEnvironment {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['DANT_GUEST_HOST', 'DANT_GUEST_PORT'].includes(key)) ||
    !Object.hasOwn(value, 'DANT_GUEST_HOST') ||
    !Object.hasOwn(value, 'DANT_GUEST_PORT')
  ) {
    throw Error('Invalid public VM environment configuration.');
  }
  return publicVmEnvironment(value);
}

export function allowedLocalOrigin(
  origin: unknown,
  env: ConfigurationEnvironment = process.env,
): boolean {
  if (!origin) return true;
  if (typeof origin !== 'string') return false;
  if (origin === 'http://tauri.localhost' || origin === 'tauri://localhost') return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    origin !== parsed.origin ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    !protocol.loopbackHosts.includes(parsed.hostname)
  )
    return false;
  const network = readNetworkConfig(env);
  return !parsed.port || [network.api.port, network.development.port].includes(Number(parsed.port));
}
