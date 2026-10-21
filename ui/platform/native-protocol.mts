import canonical from '../../resources/config/protocol.json' with { type: 'json' };
import { validateProtocol } from '../shared/network-protocol.mts';
import type { Protocol } from '../shared/network-protocol.mts';

export { MAX_PORT } from '../shared/network-protocol.mts';
const protocol = validateProtocol(canonical);

// Fixed native IPC endpoints; host configuration and transport policy belong to Go.
export const NATIVE_PROTOCOL = Object.freeze({
  host: protocol.loopbackHost,
  port: protocol.apiPort,
  httpOrigin: `http://${protocol.loopbackHost}:${protocol.apiPort}`,
  wsOrigin: `ws://${protocol.loopbackHost}:${protocol.apiPort}`,
  devPort: protocol.devPort,
  paths: protocol.paths,
});

/** Feature routes remain relative to the canonical API namespace. */
export function apiPath(route: string, paths: Protocol['paths'] = NATIVE_PROTOCOL.paths): string {
  if (
    !route.startsWith('/') ||
    route.startsWith('//') ||
    route.includes('://') ||
    route.includes('\\') ||
    /[\x00-\x20#]/.test(route) ||
    route.split('?')[0]!.split('/').includes('..')
  )
    throw Error('Invalid local API route');
  const query = route.indexOf('?');
  const name = query < 0 ? route : route.slice(0, query);
  const suffix = query < 0 ? '' : route.slice(query);
  const canonical =
    name === '/session'
      ? paths.session
      : name === '/state'
        ? paths.state
        : name === '/version'
          ? paths.version
          : paths.api + name;
  return canonical + suffix;
}
