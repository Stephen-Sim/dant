import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { loadProjectEnv } from '../../src/config/env.mts';
import { readNetworkConfig } from '../../src/config/network.mts';
import { resolveBuildPaths } from '../ci/build-paths.mts';
import { readVersion } from '../ci/version.mts';
import { validatePreparedResources } from '../package-resources.mts';
import { CORE_GUEST_BINARY, CORE_WINDOWS } from './bundle.mts';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STOP_TIMEOUT_MS = 25_000;

export interface CoreLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

interface LaunchOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  version?: (root: string) => string;
  verify?: typeof validatePreparedResources;
}

/** Run a verified compiled artifact; source edits never silently fall back to Node. */
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
  const children: ChildProcess[] = [];
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
              return resolve();
            const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            if (child.stdin) child.stdin.end();
            else child.kill();
          }),
      ),
    ).then(() => undefined);
    return stopping;
  };
  const terminated = new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  const launchChild = (executable: string, arguments_: readonly string[], managed: boolean) => {
    const child = spawn(executable, arguments_, {
      cwd: managed ? launch.cwd : PROJECT_ROOT,
      env: managed ? launch.env : process.env,
      shell: false,
      windowsHide: true,
      stdio: [managed ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    });
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
    const core = launchChild(launch.executable, launch.args, true);
    const tasks = [core, terminated.then(() => 0)];
    if (args[0] === '--dev') {
      const network = readNetworkConfig();
      tasks.push(
        launchChild(
          process.execPath,
          [
            path.join(PROJECT_ROOT, 'node_modules/vite/bin/vite.js'),
            '--host',
            network.development.host,
            '--port',
            String(network.development.port),
          ],
          false,
        ),
      );
    }
    return await Promise.race(tasks);
  } finally {
    await stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runCoreDevelopment(process.argv.slice(2));
  } catch {
    console.error(
      'The compiled Go core could not start. Run npm run package:resources from a committed checkout first.',
    );
    process.exitCode = 1;
  }
}
