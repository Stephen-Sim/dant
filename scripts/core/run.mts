import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { loadProjectEnv } from '../config/project-env.mts';
import { readNetworkConfig } from '../config/network.mts';
import { resolveBuildPaths } from '../ci/build-paths.mts';
import { readVersion } from '../ci/version.mts';
import { validatePreparedResources } from '../package-resources.mts';
import { CORE_GUEST_BINARY, CORE_WINDOWS } from './bundle.mts';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STOP_TIMEOUT_MS = 25_000;

class CoreShutdownError extends Error {
  constructor() {
    super('Development process shutdown is unconfirmed.');
    this.name = 'CoreShutdownError';
  }
}

export interface CoreLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

type CoreProcess = Pick<
  ChildProcess,
  'pid' | 'exitCode' | 'signalCode' | 'stdin' | 'once' | 'removeListener' | 'kill'
>;

export interface CoreProcessServices {
  spawn(launch: CoreLaunch, managed: boolean): CoreProcess;
  subscribeTermination(listener: () => void): () => void;
  shutdownDeadline(listener: () => void): () => void;
}

const processServices: CoreProcessServices = {
  spawn: (launch, managed) =>
    spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      shell: false,
      windowsHide: true,
      stdio: [managed ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    }),
  subscribeTermination(listener) {
    process.once('SIGINT', listener);
    process.once('SIGTERM', listener);
    return () => {
      process.removeListener('SIGINT', listener);
      process.removeListener('SIGTERM', listener);
    };
  },
  shutdownDeadline(listener) {
    const timer = setTimeout(listener, STOP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  },
};

interface LaunchOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  version?: (root: string) => string;
  verify?: typeof validatePreparedResources;
}

/** Run verified compiled resources for the requested version and platform. */
export function coreLaunch({
  root = PROJECT_ROOT,
  env = process.env,
  platform = process.platform,
  version = readVersion,
  verify = validatePreparedResources,
}: LaunchOptions = {}): CoreLaunch {
  if (platform !== 'win32' && platform !== 'linux')
    throw Error('A core build for this host platform is not available yet.');
  const { resources } = resolveBuildPaths(root, env);
  verify(resources, version(root));
  const environment: NodeJS.ProcessEnv = {
    ...env,
    DANT_DATA: env.DANT_DATA ?? path.join(root, 'data'),
    DANT_MANAGED_STDIN: '1',
  };
  delete environment.DANT_MANAGED;
  return {
    executable: path.join(resources, platform === 'win32' ? CORE_WINDOWS : CORE_GUEST_BINARY),
    args: ['--role=controller', '--root', resources, '--config-root', root],
    cwd: resources,
    env: environment,
  };
}

export async function runCoreDevelopment(args: readonly string[]): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dev'))
    throw Error('Usage: node scripts/core/run.mts [--dev]');
  loadProjectEnv({ projectRoot: PROJECT_ROOT });
  const launch = coreLaunch();
  let development: CoreLaunch | undefined;
  if (args[0] === '--dev') {
    const network = readNetworkConfig();
    development = {
      executable: process.execPath,
      args: [
        path.join(PROJECT_ROOT, 'node_modules/vite/bin/vite.js'),
        '--host',
        network.development.host,
        '--port',
        String(network.development.port),
      ],
      cwd: PROJECT_ROOT,
      env: { ...process.env },
    };
  }

  return runCoreProcesses(launch, development);
}

/** Own the compiled core and optional dev server until either ends or the parent stops. */
export async function runCoreProcesses(
  launch: CoreLaunch,
  development?: CoreLaunch,
  services: CoreProcessServices = processServices,
): Promise<number> {
  const children: CoreProcess[] = [];
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= Promise.allSettled(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
              return resolve();
            let settled = false;
            const cleanup = () => {
              clearDeadline();
              child.removeListener('exit', stopped);
              child.removeListener('error', failed);
            };
            const stopped = () => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve();
            };
            const failed = () => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new CoreShutdownError());
            };
            const kill = (signal?: NodeJS.Signals) => {
              try {
                if (!child.kill(signal)) failed();
              } catch {
                failed();
              }
            };
            const clearDeadline = services.shutdownDeadline(() => kill('SIGKILL'));
            child.once('exit', stopped);
            child.once('error', failed);
            try {
              if (child.stdin) child.stdin.end();
              else kill();
            } catch {
              failed();
            }
          }),
      ),
    ).then((results) => {
      if (results.some((result) => result.status === 'rejected')) throw new CoreShutdownError();
    });
    return stopping;
  };
  let unsubscribe = () => {};
  const terminated = new Promise<void>((resolve) => {
    unsubscribe = services.subscribeTermination(resolve);
  });
  const launchChild = (specification: CoreLaunch, managed: boolean) => {
    const child = services.spawn(specification, managed);
    // The child may exit before its managed input closes. Its exit/error event
    // owns the result; a broken pipe must not crash the launcher separately.
    child.stdin?.on('error', () => undefined);
    children.push(child);
    return new Promise<number>((resolve) => {
      child.once('error', () => resolve(1));
      child.once('exit', (code) => resolve(code ?? 1));
    });
  };
  try {
    const core = launchChild(launch, true);
    const tasks = [core, terminated.then(() => 0)];
    if (development) tasks.push(launchChild(development, false));
    return await Promise.race(tasks);
  } finally {
    unsubscribe();
    await stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runCoreDevelopment(process.argv.slice(2));
  } catch (cause) {
    console.error(
      cause instanceof CoreShutdownError
        ? cause.message
        : 'The compiled Go core could not start. Run npm run package:resources from a committed checkout first.',
    );
    process.exitCode = 1;
  }
}
