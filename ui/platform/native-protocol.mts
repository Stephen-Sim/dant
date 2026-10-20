import protocol from '../../resources/config/protocol.json' with { type: 'json' };

export const MAX_PORT = 65_535;
// Fixed native IPC endpoints; host configuration and transport policy belong to Go.
export const NATIVE_PROTOCOL = Object.freeze({
  host: protocol.loopbackHost,
  port: protocol.apiPort,
  httpOrigin: `http://${protocol.loopbackHost}:${protocol.apiPort}`,
  wsOrigin: `ws://${protocol.loopbackHost}:${protocol.apiPort}`,
  devPort: protocol.devPort,
});
