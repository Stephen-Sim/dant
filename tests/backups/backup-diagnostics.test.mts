import test from 'node:test';
import assert from 'node:assert/strict';
import {
  workerBackupFailure,
  WorkerBackupStagingError,
} from '../../src/backups/backup-diagnostics.mts';

test('backup failure classification uses SQLite primary and extended busy results without trusting text', () => {
  for (const errcode of [5, 6, 261, 262, 517])
    assert.deepEqual(
      workerBackupFailure({ code: 'ERR_SQLITE_ERROR', errcode, message: 'private database path' }),
      { reason: 'sqlite_busy', status: 409, code: 'backup_busy' },
    );
  for (const errcode of [1, '5', -1, 5.5, Infinity, 0x80000005])
    assert.deepEqual(workerBackupFailure({ code: 'ERR_SQLITE_ERROR', errcode }), {
      reason: 'generic',
      status: 400,
      code: 'backup_failed',
    });
  assert.equal(workerBackupFailure({ code: 'unknown', errcode: 5 }).reason, 'generic');
});

test('backup failure classification bounds filesystem and source errors to fixed public reasons', () => {
  for (const code of ['EACCES', 'EPERM'])
    assert.deepEqual(workerBackupFailure({ code }), {
      reason: 'fs_permission',
      status: 400,
      code: 'backup_failed',
    });
  for (const code of ['invalid_backup', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP'])
    assert.equal(workerBackupFailure({ code }).reason, 'invalid_source');
  for (const [code, reason] of [
    ['backup_busy', 'busy'],
    ['source_changed', 'source_changed'],
  ])
    assert.deepEqual(workerBackupFailure({ code }), { reason, status: 409, code: 'backup_busy' });
});

test('backup diagnostics never read messages, paths, inherited codes or exception getters', () => {
  const secret = 'private-credential-and-user-content',
    error = {};
  Object.setPrototypeOf(error, { code: 'backup_busy' });
  Object.defineProperty(error, 'message', { get: () => assert.fail('message must not be read') });
  Object.defineProperty(error, 'errcode', { get: () => assert.fail('getter must not run') });
  Object.defineProperty(error, 'path', { get: () => assert.fail('path must not be read') });
  for (const value of [
    null,
    undefined,
    secret,
    { code: secret, message: secret, path: secret },
    error,
  ])
    assert.deepEqual(workerBackupFailure(value), {
      reason: 'generic',
      status: 400,
      code: 'backup_failed',
    });
});

test('background failure reasons remain bounded even when an error object is altered', () => {
  for (const reason of [
    'busy',
    'sqlite_busy',
    'fs_permission',
    'invalid_source',
    'source_changed',
    'generic',
  ])
    assert.equal(workerBackupFailure(new WorkerBackupStagingError(reason)).reason, reason);
  assert.equal(
    workerBackupFailure(new WorkerBackupStagingError('private-user-content')).reason,
    'generic',
  );
  const error = new WorkerBackupStagingError('busy');
  Object.defineProperty(error, 'reason', {
    get: () => assert.fail('untrusted getters must not be read'),
  });
  assert.equal(workerBackupFailure(error).reason, 'generic');
});
