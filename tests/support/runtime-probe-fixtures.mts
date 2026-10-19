import { spawnSync } from 'node:child_process';
import type { NodeProbeRunner } from '../../scripts/ci/node-runtime.mts';

/** Replace only node:sqlite in an isolated process; no application or disk database is loaded. */
export function sqliteProbeRunner(moduleSource: string): NodeProbeRunner {
  const moduleURL = 'data:text/javascript,' + encodeURIComponent(moduleSource);
  const hooks = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier, context, nextResolve) {
  return specifier === 'node:sqlite'
    ? {url:${JSON.stringify(moduleURL)},shortCircuit:true}
    : nextResolve(specifier,context);
}});`;
  const hookURL = 'data:text/javascript,' + encodeURIComponent(hooks);
  return (executable, args, options) =>
    spawnSync(executable, ['--import', hookURL, ...args], options);
}

export const unavailableSqliteModules = [
  '',
  'throw Error("PRIVATE_SQLITE_FAILURE");',
  'export class DatabaseSync { exec() {throw Error("PRIVATE_FTS5_FAILURE");} close() {} }',
  'export class DatabaseSync {exec() {} prepare() {return {run() {},get() {return {text:"wrong"};}};} close() {}}',
] as const;
