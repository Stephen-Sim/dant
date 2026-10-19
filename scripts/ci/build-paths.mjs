import path from 'node:path';

function absolute(value, name) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value))
    throw Error(`${name} must be an absolute path without NUL characters.`);
  return path.resolve(value);
}

/** Cargo outputs may be isolated while the artifact download directory stays fixed. */
export function resolveBuildPaths(root, env = process.env) {
  const project = absolute(root, 'Project root'),
    defaultTarget = path.join(project, 'src-tauri', 'target');
  const target =
    env.CARGO_TARGET_DIR === undefined
      ? defaultTarget
      : absolute(env.CARGO_TARGET_DIR, 'CARGO_TARGET_DIR');
  const release = path.join(target, 'release');
  return {
    target,
    release,
    backend: path.join(release, 'backend'),
    resources: path.join(project, 'src-tauri', 'resources'),
    output: path.join(defaultTarget, 'ci-artifacts'),
    stagingPrefix: path.join(target, 'ci-portable-'),
  };
}

/** Only the direct temporary directory allocated for this target may be removed. */
export function assertStagingPath(target, staging) {
  const resolvedTarget = absolute(target, 'Cargo target'),
    resolvedStaging = absolute(staging, 'Staging directory'),
    relative = path.relative(resolvedTarget, resolvedStaging);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep) ||
    !relative.startsWith('ci-portable-') ||
    relative.length <= 'ci-portable-'.length
  )
    throw Error('Refusing to remove a staging directory outside the selected Cargo target.');
  return resolvedStaging;
}
