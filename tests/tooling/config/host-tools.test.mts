import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHostTools } from '../../../scripts/config/host-tools.mts';

test('host tools use the selected Windows directories across drives and account layouts', () => {
  const tools = resolveHostTools('win32', {
    SYSTEMROOT: 'R:/系统/Windows',
    ProgramFiles: 'S:/Applications',
  });
  assert.deepEqual(tools, {
    openSshDirectory: 'R:\\系统\\Windows\\System32\\OpenSSH',
    bash: 'S:\\Applications\\Git\\bin\\bash.exe',
    tar: 'R:\\系统\\Windows\\System32\\tar.exe',
  });
  assert.equal(Object.isFrozen(tools), true);
});

test('non-Windows build hosts retain PATH tools without reading Windows environment values', () => {
  assert.deepEqual(resolveHostTools('linux', {}), {
    openSshDirectory: null,
    bash: 'bash',
    tar: 'tar',
  });
});

test('missing, relative, malformed and ambiguous Windows directories fail without exposing values', () => {
  const valid = { SystemRoot: 'R:/Windows', ProgramFiles: 'S:/Programs' };
  for (const name of ['SystemRoot', 'ProgramFiles'] as const) {
    for (const value of [
      undefined,
      '',
      'private-relative-directory',
      '/Windows',
      'R:Windows',
      'R:/bad\0value',
      'R:/' + 'x'.repeat(4096),
    ]) {
      assert.throws(
        () => resolveHostTools('win32', { ...valid, [name]: value }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === `The Windows ${name} directory must be set to an absolute path.`,
      );
    }
  }
  assert.throws(() => resolveHostTools('win32', { ...valid, SYSTEMROOT: 'T:/Other' }));
  assert.equal(
    resolveHostTools('win32', { ...valid, SYSTEMROOT: valid.SystemRoot }).tar,
    'R:\\Windows\\System32\\tar.exe',
  );
});
