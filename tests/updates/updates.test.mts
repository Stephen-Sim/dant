import { errorCode, errorMessage, isRecord } from '../../src/contracts/json.mts';
import type { UpdateServiceOptions } from '../../src/updates/updates.mts';
import { defined } from '../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UpdateService,
  compareVersions,
  REPOSITORY_URL,
  RELEASES_URL,
  LATEST_RELEASE_API,
  RELEASES_API,
  MAX_INSTALLER_BYTES,
} from '../../src/updates/updates.mts';

const release = (tag = 'v0.5.0', patch = {}) => ({
  draft: false,
  prerelease: tag.includes('-'),
  tag_name: tag,
  html_url: RELEASES_URL + '/tag/' + tag,
  published_at: '2026-10-17T00:00:00Z',
  ...patch,
});
const installer = (tag = 'v0.5.0', patch = {}) => {
  const name = `dant_${tag.replace(/^v/, '')}_windows_x64_setup.exe`;
  return {
    name,
    state: 'uploaded',
    size: 4096,
    digest: 'sha256:' + 'a'.repeat(64),
    browser_download_url: RELEASES_URL + '/download/' + tag + '/' + name,
    ...patch,
  };
};
const service = (options: UpdateServiceOptions) =>
  new UpdateService({ version: '0.4.5', ...options });
const code = (expected: string) => (error: unknown) => {
  assert.equal(errorCode(error), expected);
  assert.equal(
    isRecord(error) ? error.status : undefined,
    expected === 'UPDATE_TIMEOUT' ? 504 : expected === 'UPDATE_RATE_LIMITED' ? 503 : 502,
  );
  assert.ok(!errorMessage(error).includes('private-'));
  return true;
};

test('version metadata is available locally and constructing an update service never makes a request', () => {
  let calls = 0;
  const updates = service({
    fetchImpl: async () => {
      calls++;
      throw Error('Unexpected update request.');
    },
  });
  assert.deepEqual(updates.info(), {
    version: '0.4.5',
    repositoryUrl: REPOSITORY_URL,
    releasesUrl: RELEASES_URL,
  });
  assert.equal(calls, 0);
  updates.close();
});

test('SemVer comparison handles numeric releases, prereleases, metadata and large components', () => {
  for (const [left, right, expected] of [
    ['0.4.10', '0.4.9', 1],
    ['1.0.0', '0.99.99', 1],
    ['0.9.9', '1.0.0', -1],
    ['1.0.1', '1.0.2', -1],
    ['1.0.0', '1.0.0', 0],
    ['1.0.0+build.2', '1.0.0+build.1', 0],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-beta', '1.0.0', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-beta.11', '1.0.0-beta.2', 1],
    ['1.0.0-1', '1.0.0-beta', -1],
    ['1.0.0-beta', '1.0.0-1', 1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
    ['1.0.0-rc', '1.0.0-beta', 1],
    ['1.0.0-rc', '1.0.0-rc.1', -1],
    ['1.0.0-rc.1', '1.0.0-rc', 1],
    ['1.0.0-rc.1', '1.0.0-rc.1', 0],
    ['9007199254740993.0.0', '9007199254740992.0.0', 1],
  ])
    assert.equal(compareVersions(left, right), expected, left + ' vs ' + right);
  for (const invalid of ['unknown', '01.0.0', '1.0', '1.0.0-01', 'v1.0.0', null, '1'.repeat(65)])
    assert.throws(() => compareVersions(invalid, '1.0.0'), /Invalid application version/);
});

test('manual checks use a fixed unauthenticated endpoint, deduplicate requests and cache success for one minute', async () => {
  let calls = 0,
    finish: (() => void) | undefined,
    now = Date.UTC(2026, 9, 17);
  const updates = service({
    now: () => now,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, LATEST_RELEASE_API);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers['X-Dant-Token'], undefined);
      assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
      assert.ok(options.signal instanceof AbortSignal);
      if (calls === 1) await new Promise<void>((resolve) => (finish = resolve));
      return Response.json(release());
    },
  });
  const first = updates.check(),
    second = updates.check();
  assert.equal(calls, 1);
  assert.equal(first, second);
  defined(finish)();
  const result = await first;
  assert.deepEqual(result, {
    currentVersion: '0.4.5',
    latestVersion: '0.5.0',
    updateAvailable: true,
    releaseUrl: RELEASES_URL + '/tag/v0.5.0',
    checkedAt: '2026-10-17T00:00:00.000Z',
    channel: 'stable',
    asset: null,
  });
  const cached = await updates.check();
  cached.latestVersion = 'mutated';
  assert.equal((await updates.check()).latestVersion, '0.5.0');
  assert.equal(calls, 1);
  now += 60000;
  assert.equal((await updates.check()).checkedAt, '2026-10-17T00:01:00.000Z');
  assert.equal(calls, 2);
  updates.close();
  await assert.rejects(updates.check(), code('UPDATE_UNAVAILABLE'));
});

test('equal, older and prerelease installed versions never produce a false downgrade', async () => {
  for (const [version, tag, available] of [
    ['0.5.0', 'v0.5.0', false],
    ['0.6.0', 'v0.5.0', false],
    ['0.5.0-beta.1', 'v0.5.0', true],
    ['0.6.0-beta.1', '0.5.0', false],
  ] as const) {
    const updates = service({ version, fetchImpl: async () => Response.json(release(tag)) });
    assert.equal((await updates.check()).updateAvailable, available);
    updates.close();
  }
});

test('drafts, prereleases, invalid versions and external release URLs are rejected', async () => {
  for (const payload of [
    null,
    [],
    {},
    release('v0.5.0', { draft: true }),
    release('v0.5.0', { prerelease: true }),
    release('v0.5.0', { draft: undefined }),
    release('v0.5.0', { prerelease: undefined }),
    release('v0.5.0-rc.1'),
    release('v00.5.0'),
    release('v0.5.0+meta'),
    release('V0.5.0'),
    release('v0.5.0', { tag_name: 5 }),
    release('v0.5.0', { html_url: 'https://evil.example/releases/tag/v0.5.0' }),
    release('v0.5.0', { html_url: RELEASES_URL + '/tag/v0.5.0?token=private-token' }),
    release('v0.5.0', { html_url: RELEASES_URL + '/tag/v0.5.1' }),
    release('v0.5.0', { html_url: 'https://github.com/Stephen-Sim/dant.evil/releases/tag/v0.5.0' }),
  ]) {
    const updates = service({ fetchImpl: async () => Response.json(payload) });
    await assert.rejects(updates.check(), code('UPDATE_INVALID_RELEASE'));
    updates.close();
  }
  let calls = 0;
  const invalid = service({
    version: 'unknown',
    fetchImpl: async () => {
      calls++;
      throw Error('Unexpected invalid-version request.');
    },
  });
  await assert.rejects(invalid.check(), code('UPDATE_INVALID_RELEASE'));
  assert.equal(calls, 0);
  invalid.close();
});

test('HTTP/network errors contain no upstream error text and a subsequent manual check retries', async () => {
  for (const [status, expected] of [
    [403, 'UPDATE_RATE_LIMITED'],
    [429, 'UPDATE_RATE_LIMITED'],
    [404, 'UPDATE_UNAVAILABLE'],
    [500, 'UPDATE_UNAVAILABLE'],
    [302, 'UPDATE_UNAVAILABLE'],
  ] as const) {
    let calls = 0;
    const updates = service({
      fetchImpl: async () =>
        ++calls === 1
          ? new Response('private-upstream-body', { status })
          : Response.json(release()),
    });
    await assert.rejects(updates.check(), code(expected));
    assert.equal((await updates.check()).updateAvailable, true);
    assert.equal(calls, 2);
    updates.close();
  }
  const updates = service({
    fetchImpl: async () => {
      throw Error('private-network-token');
    },
  });
  await assert.rejects(updates.check(), code('UPDATE_UNAVAILABLE'));
  updates.close();
});

test('JSON responses are bounded by both content length and actual bytes, including malformed/empty bodies', async () => {
  let cancelled = false;
  const oversized = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(129));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  for (const response of [
    new Response('{}', { headers: { 'Content-Length': '129' } }),
    oversized,
    new Response('private-invalid-json'),
    new Response(null),
  ]) {
    const updates = service({ maxBytes: 128, fetchImpl: async () => response });
    await assert.rejects(updates.check(), code('UPDATE_INVALID_RELEASE'));
    updates.close();
  }
  assert.equal(cancelled, true);
});

test('stream and cancellation failures never expose their raw error or replace the safe failure', async () => {
  const failed = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(Error('private-stream-error'));
        },
      }),
    ),
    updates = service({ fetchImpl: async () => failed });
  await assert.rejects(updates.check(), code('UPDATE_UNAVAILABLE'));
  updates.close();
  const tooLong = new Response(
      new ReadableStream({
        cancel() {
          throw Error('private-cancellation-error');
        },
      }),
      { headers: { 'Content-Length': '999' } },
    ),
    bounded = service({ maxBytes: 128, fetchImpl: async () => tooLong });
  await assert.rejects(bounded.check(), code('UPDATE_INVALID_RELEASE'));
  bounded.close();
});

test('the deadline covers connection and response body stalls and aborts the request', async () => {
  for (const bodyStall of [false, true]) {
    let signal: AbortSignal | undefined,
      cancelled = false;
    const updates = service({
      timeoutMs: 15,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        if (!bodyStall) return new Promise(() => {});
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    await assert.rejects(updates.check(), code('UPDATE_TIMEOUT'));
    assert.equal(defined(signal).aborted, true);
    assert.equal(cancelled, bodyStall);
    updates.close();
  }
});

test('closing cancels an in-flight request without waiting for the network timeout', async () => {
  let signal: AbortSignal | undefined;
  const updates = service({
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    }),
    pending = updates.check();
  updates.close();
  await assert.rejects(pending, code('UPDATE_UNAVAILABLE'));
  assert.equal(defined(signal).aborted, true);
  assert.equal(updates.cached, null);
});

test('Stable and Beta checks isolate their requests, caches, assets and version precedence', async () => {
  const calls: string[] = [],
    finish = new Map<string, () => void>(),
    updates = service({
      version: '0.5.0-beta.2',
      fetchImpl: async (url) => {
        calls.push(url);
        await new Promise<void>((resolve) => finish.set(url, resolve));
        return Response.json(
          url === LATEST_RELEASE_API
            ? release('v0.4.9', { assets: [installer('v0.4.9')] })
            : [
                release('v0.5.0-beta.11', { assets: [installer('v0.5.0-beta.11')] }),
                release('v0.5.0-beta.3'),
                release('v0.9.0', { draft: true }),
                release('v1.0.0', { published_at: null }),
                release('v0.4.9'),
              ],
        );
      },
    });
  const stable = updates.check(),
    beta = updates.check('beta');
  assert.equal(updates.check('beta'), beta);
  assert.deepEqual(calls, [LATEST_RELEASE_API, RELEASES_API + '?per_page=100&page=1']);
  defined(finish.get(defined(calls[1])))();
  const preview = await beta;
  assert.equal(preview.channel, 'beta');
  assert.equal(preview.latestVersion, '0.5.0-beta.11');
  assert.equal(preview.updateAvailable, true);
  assert.equal(defined(preview.asset).name, 'dant_0.5.0-beta.11_windows_x64_setup.exe');
  defined(finish.get(defined(calls[0])))();
  assert.equal((await stable).updateAvailable, false);
  defined(preview.asset).sha256 = 'forged';
  assert.equal(defined((await updates.check('beta')).asset).sha256, 'a'.repeat(64));
  assert.equal((await updates.check()).channel, 'stable');
  assert.equal(calls.length, 2);
  updates.close();
});

test('Beta selects the highest valid published SemVer across fixed bounded pagination', async () => {
  const urls: string[] = [],
    first = Array.from({ length: 100 }, () => release('v0.4.9')),
    updates = service({
      fetchImpl: async (url) => {
        urls.push(url);
        return Response.json(
          url.endsWith('page=1')
            ? first
            : [
                release('v0.5.0-beta.11'),
                release('v0.5.0'),
                release('v0.6.0-rc.1', { prerelease: false }),
                release('v99.0.0', { draft: true }),
                release('v0.6.0-rc.2', { html_url: 'https://evil.example' }),
              ],
        );
      },
    });
  assert.equal((await updates.check('beta')).latestVersion, '0.5.0');
  assert.deepEqual(urls, [
    RELEASES_API + '?per_page=100&page=1',
    RELEASES_API + '?per_page=100&page=2',
  ]);
  updates.close();
  let calls = 0;
  const bounded = service({
    fetchImpl: async () => {
      calls++;
      return Response.json(first);
    },
  });
  await assert.rejects(bounded.check('beta'), code('UPDATE_INVALID_RELEASE'));
  assert.equal(calls, 10);
  bounded.close();
});

test('only exact official uploaded Windows assets with bounded size and SHA256 enable native download', async () => {
  const good = installer(),
    bad = [
      { ...good, name: 'dant.exe' },
      { ...good, state: 'new' },
      { ...good, size: 0 },
      { ...good, size: MAX_INSTALLER_BYTES + 1 },
      { ...good, size: 1.5 },
      { ...good, digest: null },
      { ...good, digest: 'md5:' + 'a'.repeat(64) },
      { ...good, digest: 'sha256:bad' },
      { ...good, browser_download_url: good.browser_download_url + '?secret=private-token' },
      { ...good, browser_download_url: good.browser_download_url.replace('Stephen-Sim', 'evil') },
      { ...good, browser_download_url: good.browser_download_url.replace('v0.5.0', 'v9.0.0') },
    ];
  for (const asset of bad) {
    const updates = service({
      fetchImpl: async () => Response.json(release('v0.5.0', { assets: [asset] })),
    });
    assert.equal((await updates.check()).asset, null);
    updates.close();
  }
  const valid = service({
    fetchImpl: async () =>
      Response.json(
        release('v0.5.0', { assets: [{ ...good, digest: 'sha256:' + 'A'.repeat(64) }] }),
      ),
  });
  assert.deepEqual((await valid.check()).asset, {
    version: '0.5.0',
    channel: 'stable',
    url: good.browser_download_url,
    name: good.name,
    size: good.size,
    sha256: 'a'.repeat(64),
  });
  valid.close();
  const duplicate = service({
    fetchImpl: async () => Response.json(release('v0.5.0', { assets: [good, good] })),
  });
  assert.equal((await duplicate.check()).asset, null);
  duplicate.close();
});

test('unknown channels do not contact GitHub and close aborts both channel checks', async () => {
  const signals: AbortSignal[] = [],
    updates = service({
      fetchImpl: async (_url, options) => {
        signals.push(options.signal);
        return new Promise(() => {});
      },
    });
  for (const channel of ['nightly', 'https://evil.example', [], {}])
    await assert.rejects(
      updates.check(channel),
      (error) =>
        errorCode(error) === 'UPDATE_INVALID_CHANNEL' && isRecord(error) && error.status === 400,
    );
  assert.equal(signals.length, 0);
  const a = updates.check(),
    b = updates.check('beta');
  updates.close();
  await assert.rejects(a, code('UPDATE_UNAVAILABLE'));
  await assert.rejects(b, code('UPDATE_UNAVAILABLE'));
  assert.ok(signals.every((signal) => signal.aborted));
});
