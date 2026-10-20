// Build/development endpoints and public deployment metadata; production transport belongs to Go.
import { MAX_PORT, PROTOCOL as protocol } from './protocol.mts';
export { MAX_PORT } from './protocol.mts';

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
}

export const NETWORK_DEFAULTS = Object.freeze({
  host: protocol.loopbackHost,
  apiPort: protocol.apiPort,
  devPort: protocol.devPort,
});
export const PROTOCOL_PATHS = Object.freeze({ ...protocol.paths });

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
  });
}
