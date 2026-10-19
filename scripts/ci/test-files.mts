import fs from 'node:fs';
import path from 'node:path';

/** Discover maintained Node tests in every feature folder, in stable order. */
export function discoverTests(root: string, directory = 'tests'): string[] {
  return fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return discoverTests(root, name);
      return entry.isFile() && entry.name.endsWith('.test.mts') ? [name] : [];
    })
    .sort();
}
