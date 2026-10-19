import fs from 'node:fs';
export { LocalWorker as Worker } from './local-worker.mts';

// SSH belongs to the transport boundary only. Codex itself is never launched
// through a host-side executor; LocalWorker exists solely in --vm-worker mode.
export interface SshConnection {
  host: string;
  user: string;
  port: number;
  keyPath: string;
  knownHosts: string;
}
export function sshArgs(vm: SshConnection) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(vm.host) ||
    !/^[a-z_][a-z0-9_-]*$/i.test(vm.user) ||
    !Number.isInteger(Number(vm.port)) ||
    vm.port < 1 ||
    vm.port > 65535
  )
    throw Error('Invalid VM connection settings');
  if (!vm.keyPath || !fs.existsSync(vm.keyPath)) throw Error('SSH private key not found');
  if (typeof vm.knownHosts !== 'string' || !vm.knownHosts)
    throw Error('SSH known-hosts path is required');
  return [
    '-T',
    '-p',
    String(vm.port),
    '-i',
    vm.keyPath,
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${vm.knownHosts}`,
  ];
}
