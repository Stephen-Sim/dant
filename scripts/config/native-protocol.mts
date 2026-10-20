import fs from 'node:fs/promises';
import path from 'node:path';
import { format } from 'prettier';
import { configLoopback, configPort } from './network.mts';
import { parseProtocolJSON } from './protocol.mts';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Tauri's static JSON is a generated consumer of the canonical native protocol. */
export function nativeProtocolFields(input: unknown) {
  if (
    !record(input) ||
    typeof input.loopbackHost !== 'string' ||
    !Number.isInteger(input.apiPort) ||
    !Number.isInteger(input.devPort)
  )
    throw Error('Invalid canonical native protocol.');
  const host = configLoopback(input.loopbackHost, 'loopbackHost');
  const apiPort = configPort(input.apiPort, 'apiPort', 0);
  const devPort = configPort(input.devPort, 'devPort', 0);
  const origin = `http://${host}:${apiPort}`;
  const socket = `ws://${host}:${apiPort}`;
  return {
    devUrl: `http://${host}:${devPort}`,
    beforeDevCommand: `npm run package:resources && npx vite --host ${host} --port ${devPort}`,
    csp: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${origin} ${socket} https: wss:; img-src 'self' data: blob: ${origin}; media-src 'self' blob: ${origin}; style-src 'self' 'unsafe-inline'`,
  };
}

export async function nativeProtocolOutputs(root: string): Promise<[string, string][]> {
  const protocol = parseProtocolJSON(
    await fs.readFile(path.join(root, 'resources/config/protocol.json'), 'utf8'),
  );
  const configuration: unknown = JSON.parse(
    await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
  );
  if (
    !record(configuration) ||
    !record(configuration.build) ||
    !record(configuration.app) ||
    !record(configuration.app.security)
  )
    throw Error('Invalid native application configuration.');
  const fields = nativeProtocolFields(protocol);
  const output = {
    ...configuration,
    build: {
      ...configuration.build,
      devUrl: fields.devUrl,
      beforeDevCommand: fields.beforeDevCommand,
    },
    app: {
      ...configuration.app,
      security: { ...configuration.app.security, csp: fields.csp },
    },
  };
  return [
    [
      'src-tauri/tauri.conf.json',
      await format(JSON.stringify(output), { parser: 'json', printWidth: 100 }),
    ],
  ];
}
