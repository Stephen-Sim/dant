import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ControllerBackups } from '../../src/backups/controller-backups.mts';
import type { BackupTarget, BackupTransport } from '../../src/backups/controller-backups.mts';
import { BackupMode, BackupPhase } from '../../src/contracts/states.mts';
import { BACKUP_RETRY_DELAY_MS } from '../../src/backups/backup-constants.mts';
import { defined } from '../support/fixture-assertions.mts';

const root = path.resolve('.cache/tests');
const protection = {
  protect: async (value: string) => Buffer.from(value),
  unprotect: async (value: Buffer) => value.toString(),
};
function fixture(t: TestContext) {
  fs.mkdirSync(root, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(root, 'controller-backups-'));
  let now = 100_000,
    exports = 0,
    restores = 0,
    reconciles = 0,
    restored = false,
    failRestore = false,
    permitted = true;
  let target: BackupTarget = {
    identity: '1'.repeat(64),
    generation: 1,
    online: true,
    supported: true,
    empty: false,
    version: '0.4.7-beta.8',
  };
  const transport: BackupTransport = {
    target: async () => ({ ...target }),
    export: async () => {
      exports++;
      return {
        metadata: { createdAt: now, appVersion: '0.4.7-beta.8', files: 1, bytes: 7 },
        stream: Readable.from([Buffer.from('fixture')]),
        close: async () => {},
      };
    },
    restore: async (input, _restoreId, captured) => {
      restores++;
      assert.equal(captured.identity, target.identity);
      let bytes = '';
      for await (const chunk of input) bytes += String(chunk);
      assert.equal(bytes, 'fixture');
      if (failRestore) throw Error('Transport acknowledgement lost');
      restored = true;
    },
    reconcile: async () => {
      reconciles++;
      return restored;
    },
    rejected: async () => false,
  };
  const create = () =>
    new ControllerBackups({
      dataDir,
      transport,
      protection,
      now: () => now,
      allowed: () => permitted,
    });
  const backups = create();
  t.after(() => {
    backups.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    backups,
    create,
    transport,
    dataDir,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    target: (patch: Partial<BackupTarget>) => {
      target = { ...target, ...patch };
    },
    failRestore: () => {
      failRestore = true;
    },
    confirm: () => {
      restored = true;
    },
    permit: (value: boolean) => {
      permitted = value;
    },
    counts: () => ({ exports, restores, reconciles }),
  };
}

test('backup mode, interval and trigger settings persist with strict limits', async (t) => {
  const f = fixture(t);
  assert.equal((await f.backups.status()).settings.mode, BackupMode.Automatic);
  f.backups.configure({
    mode: BackupMode.Manual,
    intervalMinutes: 15,
    onConnect: false,
    beforeVmChange: false,
    retainCount: 2,
  });
  const next = f.create();
  t.after(() => next.close());
  assert.deepEqual((await next.status()).settings, {
    mode: BackupMode.Manual,
    intervalMinutes: 15,
    onConnect: false,
    beforeVmChange: false,
    retainCount: 2,
  });
  for (const invalid of [
    { intervalMinutes: 1 },
    { intervalMinutes: 10_081 },
    { onConnect: 'yes' },
    { mode: 'cron' },
    { unknown: true },
    { retainCount: 0 },
  ])
    assert.throws(() => next.configure(invalid), /backup_settings_invalid/);
});

test('manual mode disables every automatic trigger while explicit backup still works', async (t) => {
  const f = fixture(t);
  f.backups.configure({ mode: BackupMode.Manual });
  await f.backups.tick();
  await f.backups.beforeVmChange();
  f.advance(24 * 60 * 60_000);
  await f.backups.tick();
  assert.deepEqual(f.counts(), { exports: 0, restores: 0, reconciles: 0 });
  f.backups.run();
  assert.equal(f.backups.phase, BackupPhase.BackingUp);
  await f.backups.pending;
  const status = await f.backups.status();
  assert.equal(status.phase, BackupPhase.Idle);
  assert.equal(status.backups.length, 1);
  assert.equal(status.backups[0]?.source, '1'.repeat(12));
  assert.equal(status.nextAt, null);
});

test('automatic backup runs on connection and interval, coalescing concurrent checks', async (t) => {
  const f = fixture(t);
  await f.backups.tick();
  await f.backups.tick();
  await f.backups.pending;
  assert.equal(f.counts().exports, 1);
  await f.backups.tick();
  assert.equal(f.counts().exports, 1);
  f.advance(60 * 60_000);
  await f.backups.tick();
  await f.backups.pending;
  assert.equal(f.counts().exports, 2);
  f.target({ generation: 2 });
  await f.backups.tick();
  await f.backups.pending;
  assert.equal(f.counts().exports, 2, 'a connection storm does not duplicate a fresh snapshot');
});

test('automatic backups defer without stopping or submitting work when service is busy or unavailable', async (t) => {
  const f = fixture(t);
  f.permit(false);
  await f.backups.tick();
  assert.equal(f.counts().exports, 0);
  f.permit(true);
  f.target({ online: false });
  await f.backups.tick();
  f.target({ online: true, supported: false });
  await f.backups.tick();
  assert.equal(f.counts().exports, 0);
  assert.equal((await f.backups.status()).availability.reason, 'backup_service_update_required');
});

test('disabling the connection trigger waits for the configured interval before the first scheduled backup', async (t) => {
  const f = fixture(t);
  f.backups.configure({ onConnect: false, intervalMinutes: 15 });
  await f.backups.tick();
  assert.equal(f.counts().exports, 0);
  const first = (await f.backups.status()).nextAt;
  f.advance(14 * 60_000);
  await f.backups.tick();
  assert.equal(f.counts().exports, 0);
  assert.equal(
    (await f.backups.status()).nextAt,
    first,
    'reading settings does not postpone the schedule',
  );
  f.advance(60_000);
  await f.backups.tick();
  await f.backups.pending;
  assert.equal(f.counts().exports, 1);
});

test('a connection change before capture is saved rejects the archive', async (t) => {
  const f = fixture(t),
    original = f.transport.export;
  f.transport.export = async (signal) => {
    const value = await original(signal);
    f.target({ generation: 2 });
    return value;
  };
  f.backups.run();
  await f.backups.pending;
  assert.equal(f.backups.phase, BackupPhase.Failed);
  assert.equal(f.backups.lastError, 'backup_connection_changed');
  assert.deepEqual((await f.backups.status()).backups, []);
});

test('VM change requires a completed local snapshot and never queues a delayed connection mutation', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.backups.beforeVmChange(), /backup_before_vm_change_required/);
  await f.backups.pending;
  await f.backups.beforeVmChange();
  assert.equal(f.counts().exports, 1);
  f.target({ identity: '2'.repeat(64), generation: 2 });
  await assert.rejects(f.backups.beforeVmChange(), /backup_before_vm_change_required/);
  await f.backups.pending;
  assert.equal(f.counts().exports, 2);
});

test('restore needs a fresh, single-use preview bound to its backup and connection generation', async (t) => {
  const f = fixture(t);
  f.backups.run();
  await f.backups.pending;
  const id = defined((await f.backups.status()).backups[0]).id;
  const preview = await f.backups.previewRestore(id);
  assert.ok(preview.warnings.includes('replaces-current-data'));
  assert.ok(preview.warnings.includes('tasks-remain-paused'));
  assert.throws(() => f.backups.restore(id, 'wrong'), /backup_preview_expired/);
  assert.equal(f.counts().restores, 0);
  const fresh = await f.backups.previewRestore(id);
  f.target({ generation: 2 });
  f.backups.restore(id, fresh.confirmation);
  await f.backups.pending;
  assert.equal(f.counts().restores, 0);
  assert.equal(f.backups.lastError, 'backup_connection_changed');
  const expired = await f.backups.previewRestore(id);
  f.advance(6 * 60_000);
  assert.throws(() => f.backups.restore(id, expired.confirmation), /backup_preview_expired/);
});

test('confirmed restore removes only its durable receipt after the restarted Worker confirms loaded data', async (t) => {
  const f = fixture(t);
  f.backups.run();
  await f.backups.pending;
  const id = defined((await f.backups.status()).backups[0]).id;
  const preview = await f.backups.previewRestore(id);
  f.backups.restore(id, preview.confirmation);
  await f.backups.pending;
  assert.equal(f.backups.phase, BackupPhase.Idle);
  assert.equal(f.backups.lastRestoredId, id);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'backup-restore.json')), false);
  assert.equal(f.counts().restores, 1);
  assert.equal(f.counts().reconciles, 1);
  assert.throws(() => f.backups.restore(id, preview.confirmation), /backup_preview_expired/);
});

test('lost restore acknowledgement survives restart and only read-only reconciliation can resolve it', async (t) => {
  const f = fixture(t);
  f.backups.run();
  await f.backups.pending;
  const id = defined((await f.backups.status()).backups[0]).id;
  const preview = await f.backups.previewRestore(id);
  f.failRestore();
  f.backups.restore(id, preview.confirmation);
  await f.backups.pending;
  assert.equal(f.backups.phase, BackupPhase.Unknown);
  assert.equal(f.counts().restores, 1);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'backup-restore.json')), true);
  f.backups.close();
  const next = f.create();
  t.after(() => next.close());
  assert.throws(() => next.run(), /backup_restore_unconfirmed/);
  await next.tick();
  assert.equal(f.counts().restores, 1);
  f.advance(BACKUP_RETRY_DELAY_MS);
  f.confirm();
  await next.tick();
  assert.equal(next.phase, BackupPhase.Idle);
  assert.equal(next.lastRestoredId, id);
  assert.equal(f.counts().restores, 1, 'an unknown import is never uploaded or replayed');
});

test('malformed persistent preferences disable automatic backup and malformed restore receipts remain unknown', async (t) => {
  const f = fixture(t);
  f.backups.close();
  fs.writeFileSync(path.join(f.dataDir, 'backup-settings.json'), '{"mode":"unrecognized"}');
  fs.writeFileSync(path.join(f.dataDir, 'backup-restore.json'), '{"restoreId":"bad"}');
  const next = f.create();
  t.after(() => next.close());
  assert.equal(next.settings.mode, BackupMode.Manual);
  assert.equal(next.phase, BackupPhase.Unknown);
  await next.tick();
  assert.equal(f.counts().exports, 0);
  assert.equal(f.counts().restores, 0);
});

test('exact authenticated rejection clears only its restore intent and never marks a restore complete or resubmits', async (t) => {
  const f = fixture(t);
  f.backups.configure({ mode: BackupMode.Manual });
  f.backups.run();
  await f.backups.pending;
  const id = defined((await f.backups.status()).backups[0]).id,
    preview = await f.backups.previewRestore(id);
  f.failRestore();
  f.transport.rejected = async () => true;
  f.backups.restore(id, preview.confirmation);
  await f.backups.pending;
  assert.equal(f.backups.phase, BackupPhase.Failed);
  assert.equal(f.backups.lastError, 'backup_restore_rejected');
  assert.equal(f.backups.lastRestoredId, null);
  assert.equal(f.backups.busy, false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'backup-restore.json')), false);
  await f.backups.tick();
  assert.equal(f.counts().restores, 1);
});

test('a damaged catalog entry reports a fixed error while preserving the valid restore list', async (t) => {
  const f = fixture(t);
  f.backups.run();
  await f.backups.pending;
  const good = defined((await f.backups.status()).backups[0]);
  const badId = '00000000-0000-4000-8000-000000000009';
  fs.writeFileSync(f.backups.vault.file(badId), 'corrupt isolated archive');
  const status = await f.backups.status();
  assert.equal(status.lastError, 'backup_invalid');
  assert.deepEqual(status.backups, [good]);
  assert.equal((await f.backups.previewRestore(good.id)).backup.id, good.id);
  await assert.rejects(f.backups.previewRestore(badId), { code: 'backup_invalid' });
  assert.equal(fs.existsSync(f.backups.vault.file(badId)), true);
});

test('restart can reconcile a durable rejection without replaying the restore or clearing a mismatching intent', async (t) => {
  const f = fixture(t);
  f.backups.run();
  await f.backups.pending;
  const id = defined((await f.backups.status()).backups[0]).id,
    preview = await f.backups.previewRestore(id);
  f.failRestore();
  f.backups.restore(id, preview.confirmation);
  await f.backups.pending;
  f.backups.close();
  f.transport.rejected = async () => true;
  const next = f.create();
  t.after(() => next.close());
  await next.tick();
  assert.equal(next.phase, BackupPhase.Failed);
  assert.equal(next.lastRestoredId, null);
  assert.equal(f.counts().restores, 1);
  const other = fixture(t);
  other.backups.run();
  await other.backups.pending;
  const otherId = defined((await other.backups.status()).backups[0]).id,
    otherPreview = await other.backups.previewRestore(otherId);
  other.failRestore();
  other.transport.rejected = async () => {
    fs.writeFileSync(
      path.join(other.dataDir, 'backup-restore.json'),
      JSON.stringify({ restoreId: 'different', target: '2'.repeat(64) }),
    );
    return true;
  };
  other.backups.restore(otherId, otherPreview.confirmation);
  await other.backups.pending;
  assert.equal(other.backups.phase, BackupPhase.Unknown);
  assert.equal(fs.existsSync(path.join(other.dataDir, 'backup-restore.json')), true);
});
