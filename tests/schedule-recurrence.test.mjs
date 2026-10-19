import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextScheduleAt,
  parseScheduleCron,
  schedulePriority,
  orderScheduledQueue,
} from '../src/schedules/schedule-recurrence.mjs';

const next = (cron, after, timeZone = 'UTC') =>
  new Date(nextScheduleAt(cron, { after: Date.parse(after), timeZone })).toISOString();

test('five-field cron supports names, lists, ascending ranges and steps without shell syntax', () => {
  const parsed = parseScheduleCron('  */15  9-17  * JAN,MAR Mon-Fri ');
  assert.equal(parsed.expression, '*/15 9-17 * jan,mar mon-fri');
  assert.deepEqual(parsed.minutes.values, [0, 15, 30, 45]);
  assert.deepEqual(parsed.months.values, [1, 3]);
  assert.deepEqual(parsed.weekdays.values, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseScheduleCron('1,8-12/2 0 * * 0,7').minutes.values, [1, 8, 10, 12]);
  assert.deepEqual(parseScheduleCron('0 0 * * 0,7').weekdays.values, [0]);
  for (const cron of [
    '',
    null,
    '@daily',
    '0 0 * *',
    '* * * * * *',
    '60 0 * * *',
    '0 24 * * *',
    '0 0 0 * *',
    '0 0 * 13 *',
    '0 0 * * 8',
    '*/0 * * * *',
    '*/61 * * * *',
    '1/2 * * * *',
    '5-1 * * * *',
    'a * * * *',
    '1,,2 * * * *',
    '0 0 * * *\necho unsafe',
    '0 0 * * mon#2',
    '0 0 L * *',
  ])
    assert.throws(
      () => parseScheduleCron(cron),
      (error) => error.status === 400,
      String(cron),
    );
});

test('daily and weekly cron use the saved timezone and return a strictly future instant', () => {
  assert.equal(
    next('0 9 * * *', '2026-10-18T00:59:59.999Z', 'Asia/Kuala_Lumpur'),
    '2026-10-18T01:00:00.000Z',
  );
  assert.equal(
    next('0 9 * * *', '2026-10-18T01:00:00.000Z', 'Asia/Kuala_Lumpur'),
    '2026-10-19T01:00:00.000Z',
  );
  assert.equal(
    next('0 9 * * mon', '2026-10-18T00:00:00Z', 'Asia/Kuala_Lumpur'),
    '2026-10-19T01:00:00.000Z',
  );
  assert.equal(next('*/15 * * * *', '2026-10-18T00:15:00Z'), '2026-10-18T00:30:00.000Z');
  assert.equal(
    next('0 0 * * *', '2026-10-18T00:00:00Z', 'Asia/Kathmandu'),
    '2026-10-18T18:15:00.000Z',
  );
});

test('restricted day-of-month and weekday use standard cron OR semantics', () => {
  assert.equal(next('0 9 15 * mon', '2026-10-18T00:00:00Z'), '2026-10-19T09:00:00.000Z');
  assert.equal(next('0 9 15 * mon', '2026-10-19T09:00:00Z'), '2026-10-26T09:00:00.000Z');
  assert.equal(next('0 9 * * mon', '2026-10-19T09:00:00Z'), '2026-10-26T09:00:00.000Z');
  assert.equal(next('0 9 15 * *', '2026-10-19T09:00:00Z'), '2026-11-15T09:00:00.000Z');
});

test('DST missing wall times are skipped while repeated wall times remain distinct real occurrences', () => {
  assert.equal(
    next('30 2 * * *', '2026-03-07T08:00:00Z', 'America/New_York'),
    '2026-03-09T06:30:00.000Z',
  );
  assert.equal(
    next('30 1 * * *', '2026-11-01T00:00:00Z', 'America/New_York'),
    '2026-11-01T05:30:00.000Z',
  );
  assert.equal(
    next('30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York'),
    '2026-11-01T06:30:00.000Z',
  );
  assert.equal(
    next('15 2 * * *', '2026-10-03T16:00:00Z', 'Australia/Lord_Howe'),
    '2026-10-04T15:15:00.000Z',
  );
});

test('calendar search covers a leap-century gap and rejects impossible schedules within a fixed bound', () => {
  assert.equal(next('0 0 29 2 *', '2096-03-01T00:00:00Z'), '2104-02-29T00:00:00.000Z');
  assert.throws(() => next('0 0 31 2 *', '2026-10-18T00:00:00Z'), /eight years/);
  assert.throws(() => nextScheduleAt('* * * * *', { after: 0 }), /current execution/);
  assert.throws(
    () => nextScheduleAt('* * * * *', { after: Date.now(), timeZone: 'Invalid/Timezone' }),
    /IANA/,
  );
});

test('priority only rearranges scheduled queue slots and preserves original message references', () => {
  const low = { id: 'low', scheduled: true, progressPriority: 'low' },
    human = { id: 'human' },
    high = { id: 'high', scheduled: true, progressPriority: 'high' },
    reply = { id: 'reply', workReply: { workId: 'specific' } },
    normal = { id: 'normal', scheduled: true },
    otherNormal = { id: 'normal-2', scheduled: true, progressPriority: 'normal' },
    queue = [low, human, high, reply, normal, otherNormal];
  assert.equal(orderScheduledQueue(queue), queue);
  assert.deepEqual(
    queue.map((item) => item.id),
    ['high', 'human', 'normal', 'reply', 'normal-2', 'low'],
  );
  assert.equal(queue[0], high);
  assert.equal(queue[1], human);
  assert.equal(queue[3], reply);
  assert.equal(schedulePriority(), 'normal');
  for (const value of ['high', 'normal', 'low']) assert.equal(schedulePriority(value), value);
  for (const value of ['urgent', null, 1, '__proto__'])
    assert.throws(() => schedulePriority(value), /priority/);
});
