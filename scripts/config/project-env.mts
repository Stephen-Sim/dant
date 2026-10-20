// Build and development tooling only; Go owns application configuration.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';

export interface ProjectEnvOptions {
  readonly projectRoot?: string;
  readonly file?: '.env';
}

// Node's native loader keeps existing process environment values. Load once at
// an application entry point, before reading configuration; never log its data.
export function loadProjectEnv({
  projectRoot = process.cwd(),
  file = '.env',
}: ProjectEnvOptions = {}): boolean {
  if (file !== '.env') throw Error('Only the project .env file can be loaded.');
  const location = path.join(path.resolve(projectRoot), file);
  const stat = fs.lstatSync(location, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw Error('The project .env must be an ordinary file no larger than 64 KiB.');
  }
  try {
    loadEnvFile(location);
  } catch {
    throw Error('The project environment file could not be loaded.');
  }
  return true;
}
