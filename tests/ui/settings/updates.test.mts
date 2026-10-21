import type {
  UpdateDriver,
  UpdatePreferences,
  UpdateInstallState,
} from '../../../ui/settings/updates.mts';
import type { UpdateAsset, UpdateProgress } from '../../../ui/platform/native-updates.mts';
import { deferred } from '../../support/service-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { createUpdates } from '../../../ui/settings/updates.mts';
import { MAX_UPDATE_BYTES } from '../../../ui/settings/update-limits.mts';

const releaseUrl = 'https://github.com/Stephen-Sim/dant/releases/tag/v1.2.0';
const update = {
  currentVersion: '1.0.0',
  latestVersion: '1.2.0',
  updateAvailable: true,
  releaseUrl,
  checkedAt: 1234,
};
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
type FixtureInstallState = UpdateInstallState & {
  call?: { id: string } | null;
  takeover?: boolean;
  active?: { turnId: string };
  queue?: string[];
};
function fixture({
  language = 'en',
  native = false,
  version = '1.0.0',
  openFailure = null,
  nativeUpdater = null,
  preferences = null,
  beforeInstall,
  installState = { mode: 'controller', call: null, provisioning: { status: 'ready' } },
}: {
  language?: string;
  native?: boolean;
  version?: string;
  openFailure?: unknown;
  nativeUpdater?: UpdateDriver | null;
  preferences?: UpdatePreferences | null;
  beforeInstall?: () => Promise<void | (() => unknown)>;
  installState?: FixtureInstallState | null;
} = {}) {
  const { document, Event } = parseHTML('<main id="app"></main>'),
    app = document.querySelector<HTMLElement>('#app'),
    requests: string[] = [],
    opened: string[] = [],
    errors: unknown[] = [];
  let request: (route: string) => Promise<unknown> = async (route) =>
    route === '/version' ? { version: '1.0.0' } : update;
  const ui = createUpdates({
    version,
    document,
    getLanguage: () => language,
    onChange: render,
    request: async (route) => {
      requests.push(route);
      return request(route);
    },
    ...(native
      ? {
          openExternal: async (url) => {
            if (openFailure) throw openFailure;
            opened.push(url);
          },
        }
      : {}),
    onOpenError: (error) => errors.push(error),
    nativeUpdater,
    preferences,
    getInstallState: () => installState,
    ...(beforeInstall ? { beforeInstall } : {}),
  });
  function render() {
    const template = document.createElement('template');
    template.innerHTML = ui.render();
    reconcile(defined(app), template.content);
    ui.bind();
  }
  render();
  return {
    ui,
    document,
    Event,
    requests,
    opened,
    errors,
    set request(value: typeof request) {
      request = value;
    },
    set language(value: string) {
      language = value;
    },
    set installState(value: typeof installState) {
      installState = value;
    },
    render,
    async enter() {
      ui.setVisible(true);
      render();
      await settle();
    },
    async click(selector: string) {
      const node = document.querySelector<HTMLSelectElement>(selector);
      assert.ok(node, selector);
      node.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
      await settle();
    },
  };
}

test('settings show the bundled version offline and only entering settings reads local version, without checking GitHub', async () => {
  const f = fixture();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-app-version]')).textContent,
    '1.0.0',
  );
  await f.click('[data-check-updates]');
  assert.deepEqual(f.requests, []);
  f.request = async () => {
    throw Error('Local controller is offline');
  };
  await f.enter();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-app-version]')).textContent,
    '1.0.0',
  );
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-check-updates]')).disabled,
    false,
  );
  assert.deepEqual(f.requests, ['/version']);
  f.ui.setVisible(true);
  await settle();
  assert.deepEqual(f.requests, ['/version']);
  f.ui.setVisible(false);
  f.request = async () => ({ version: '1.0.1' });
  await f.enter();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-app-version]')).textContent,
    '1.0.1',
  );
  assert.deepEqual(f.requests, ['/version', '/version']);
});

test('actual check button disables duplicate checks, displays a newer release and uses the native external opener', async () => {
  const f = fixture({ native: true });
  await f.enter();
  const pending = deferred<unknown>();
  f.request = () => pending.promise;
  await f.click('[data-check-updates]');
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-check-updates]')).disabled,
    true,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-check-updates]')).getAttribute(
      'aria-busy',
    ),
    'true',
  );
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /Checking/,
  );
  await f.click('[data-check-updates]');
  assert.deepEqual(f.requests, ['/version', '/updates']);
  pending.resolve(update);
  await settle();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-check-updates]')).disabled,
    false,
  );
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /1\.2\.0/,
  );
  const link = f.document.querySelector<HTMLAnchorElement>('[data-update-release]');
  assert.equal(defined(link).href, releaseUrl);
  assert.equal(defined(link).target, '_blank');
  assert.equal(defined(link).rel, 'noopener noreferrer');
  await f.click('[data-update-release]');
  assert.deepEqual(f.opened, [releaseUrl]);
});

test('both languages render current-version and retry states without exposing network or API details', async () => {
  for (const [language, current, failed, retry] of [
    ['en', 'You’re up to date.', 'Could not check for updates.', 'Try again'],
    ['zh', '已是最新版本。', '无法检查更新', '重试'],
  ] as const) {
    const f = fixture({ language });
    await f.enter();
    f.request = async () => ({ ...update, updateAvailable: false });
    await f.click('[data-check-updates]');
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
      current,
    );
    assert.equal(f.document.querySelector<HTMLAnchorElement>('[data-update-release]'), null);
    f.request = async () => {
      throw Error('private server body, token=abc');
    };
    await f.click('[data-check-updates]');
    assert.ok(
      defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent.startsWith(
        failed,
      ),
    );
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-check-updates]')).textContent,
      retry,
    );
    assert.doesNotMatch(f.document.body.textContent, /private|token=abc/);
    f.request = async () => update;
    await f.click('[data-check-updates]');
    assert.ok(f.document.querySelector<HTMLAnchorElement>('[data-update-release]'));
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-check-updates]')).disabled,
      false,
    );
  }
});

test('late responses after leaving settings never render or overwrite a later visit', async () => {
  const f = fixture(),
    oldVersion = deferred<unknown>(),
    oldCheck = deferred<unknown>();
  f.request = (route) => (route === '/version' ? oldVersion.promise : oldCheck.promise);
  f.ui.setVisible(true);
  await f.click('[data-check-updates]');
  f.ui.setVisible(false);
  f.request = async (route) =>
    route === '/version'
      ? { version: '2.0.0' }
      : {
          ...update,
          currentVersion: '2.0.0',
          latestVersion: '2.0.0',
          releaseUrl: releaseUrl.replace('v1.2.0', 'v2.0.0'),
          updateAvailable: false,
        };
  await f.enter();
  await f.click('[data-check-updates]');
  const status = defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent;
  oldVersion.resolve({ version: '0.1.0' });
  oldCheck.resolve(update);
  await settle();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-app-version]')).textContent,
    '2.0.0',
  );
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    status,
  );
  assert.equal(f.document.querySelector<HTMLAnchorElement>('[data-update-release]'), null);
});

test('leaving or unloading during a failed check ignores rejection and allows a clean next visit', async () => {
  for (const dispose of [false, true]) {
    const f = fixture();
    await f.enter();
    const pending = deferred<unknown>();
    f.request = () => pending.promise;
    await f.click('[data-check-updates]');
    if (dispose) f.ui.dispose();
    else f.ui.setVisible(false);
    pending.reject(Error('old failure'));
    await settle();
    f.request = async (route) => (route === '/version' ? { version: '1.0.0' } : update);
    await f.enter();
    await f.click('[data-check-updates]');
    assert.ok(f.document.querySelector<HTMLAnchorElement>('[data-update-release]'));
  }
});

test('malformed versions and noncanonical update URLs cannot create an external link', async () => {
  const invalid = [
    { ...update, releaseUrl: 'not a url' },
    { ...update, releaseUrl: 'javascript:alert(1)' },
    { ...update, releaseUrl: 'https://evil.example/release' },
    {
      ...update,
      releaseUrl: 'https://github.com.evil.example/Stephen-Sim/dant/releases/tag/v1.2.0',
    },
    { ...update, releaseUrl: releaseUrl + '?token=abc' },
    { ...update, releaseUrl: releaseUrl + '#bad' },
    { ...update, releaseUrl: 'https://user@github.com/Stephen-Sim/dant/releases/tag/v1.2.0' },
    { ...update, releaseUrl: 'https://github.com:8443/Stephen-Sim/dant/releases/tag/v1.2.0' },
    { ...update, releaseUrl: 22 },
    { ...update, releaseUrl: 'x'.repeat(501) },
    { ...update, currentVersion: '<img onerror=alert(1)>' },
    { ...update, latestVersion: 'garbage' },
    { ...update, updateAvailable: 'yes' },
    null,
  ];
  const f = fixture({ native: true });
  await f.enter();
  for (const item of invalid) {
    f.request = async () => item;
    await f.click('[data-check-updates]');
    assert.equal(f.document.querySelector<HTMLAnchorElement>('[data-update-release]'), null);
    assert.match(
      defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
      /Could not check/,
    );
    assert.equal(f.document.querySelector<HTMLImageElement>('img'), null);
  }
  assert.deepEqual(f.opened, []);
});

test('browser release links keep standard safe navigation and invalid local versions preserve a safe bundled value', async () => {
  const f = fixture({ version: '<unsafe>' });
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-app-version]')).textContent,
    '—',
  );
  f.request = async (route) => (route === '/version' ? { version: '<unsafe>' } : update);
  await f.enter();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-app-version]')).textContent,
    '—',
  );
  await f.click('[data-check-updates]');
  assert.equal(
    defined(f.document.querySelector<HTMLAnchorElement>('[data-update-release]')).onclick,
    null,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLAnchorElement>('[data-update-release]')).href,
    releaseUrl,
  );
  assert.equal(f.document.querySelector<HTMLElement>('unsafe'), null);
});

test('native opener errors are handled and stale detached links cannot launch after navigation', async () => {
  const error = Error('OS browser unavailable'),
    failed = fixture({ native: true, openFailure: error });
  await failed.enter();
  await failed.click('[data-check-updates]');
  await failed.click('[data-update-release]');
  assert.deepEqual(failed.errors, [error]);
  assert.equal(
    defined(failed.document.querySelector<HTMLButtonElement>('[data-check-updates]')).disabled,
    false,
  );
  const f = fixture({ native: true });
  await f.enter();
  await f.click('[data-check-updates]');
  const link = f.document.querySelector<HTMLAnchorElement>('[data-update-release]');
  f.ui.setVisible(false);
  defined(link).dispatchEvent(new f.Event('click', { cancelable: true }));
  await settle();
  assert.deepEqual(f.opened, []);
});

const verifiedUpdate = (channel: 'stable' | 'beta' = 'stable', version = '1.2.0') => {
  const name = `dant_${version}_windows_x64_setup.exe`,
    url = releaseUrl.replace('v1.2.0', 'v' + version);
  return {
    ...update,
    channel,
    latestVersion: version,
    releaseUrl: url,
    asset: {
      version,
      channel,
      name,
      url: url.replace('/tag/', '/download/') + '/' + name,
      sha256: 'a'.repeat(64),
      size: 4096,
    },
  };
};
const ready = (asset: UpdateAsset) => ({
  ready: true,
  version: asset.version,
  channel: asset.channel,
  name: asset.name,
  sha256: asset.sha256,
  size: asset.size,
});

test('settings update admission uses the same exact installer byte boundary as native download', async () => {
  const downloaded: UpdateAsset[] = [],
    f = fixture({
      nativeUpdater: {
        available: true,
        installSupported: true,
        download: async (asset) => {
          downloaded.push(asset);
          return ready(asset);
        },
        install: async () => ({ launched: true }),
      },
    });
  await f.enter();
  const verified = verifiedUpdate();
  f.request = async () => ({ ...verified, asset: { ...verified.asset, size: MAX_UPDATE_BYTES } });
  await f.click('[data-check-updates]');
  await f.click('[data-download-update]');
  assert.equal(downloaded[0]?.size, 512 * 1024 * 1024);
  f.request = async () => ({
    ...verified,
    asset: { ...verified.asset, size: MAX_UPDATE_BYTES + 1 },
  });
  await f.click('[data-check-updates]');
  assert.equal(f.document.querySelector('[data-download-update]'), null);
  assert.equal(downloaded.length, 1);
  f.ui.dispose();
});

test('channel selection persists locally, never starts work, and stale checks cannot overwrite another channel', async () => {
  const saved = new Map<string, string>(),
    preferences = {
      getItem: (key: string) => saved.get(key),
      setItem: (key: string, value: string) => saved.set(key, value),
    },
    f = fixture({ preferences });
  await f.enter();
  assert.equal(f.ui.channel, 'stable');
  const old = deferred<unknown>();
  f.request = () => old.promise;
  await f.click('[data-check-updates]');
  f.ui.setChannel('beta');
  assert.equal(f.ui.channel, 'beta');
  assert.equal(saved.get('dant.updateChannel'), 'beta');
  assert.equal(f.requests.length, 2);
  f.request = async () => verifiedUpdate('beta', '1.3.0-beta.2');
  await f.click('[data-check-updates]');
  assert.equal(f.requests.at(-1), '/updates?channel=beta');
  old.resolve(update);
  await settle();
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /1\.3\.0-beta\.2/,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLAnchorElement>('[data-update-release]')).href,
    releaseUrl.replace('v1.2.0', 'v1.3.0-beta.2'),
  );
  const restored = fixture({ preferences });
  assert.equal(restored.ui.channel, 'beta');
  const invalid = fixture({ preferences: { getItem: () => 'nightly' } });
  assert.equal(invalid.ui.channel, 'stable');
});

test('verified native download continues outside settings and keeps channel/hash progress separate', async () => {
  const pending = deferred<unknown>(),
    calls: UpdateAsset[] = [];
  let progress:
    | ((
        value: Pick<UpdateProgress, 'version' | 'channel' | 'sha256' | 'total' | 'received'> & {
          status?: string;
        },
      ) => void)
    | undefined;
  const nativeUpdater = {
      available: true,
      installSupported: true,
      download: async (
        asset: UpdateAsset,
        onProgress: (
          value: Pick<UpdateProgress, 'version' | 'channel' | 'sha256' | 'total' | 'received'>,
        ) => void,
      ) => {
        calls.push(asset);
        progress = onProgress;
        return pending.promise;
      },
      install: async () => ({ launched: true }),
    },
    f = fixture({ nativeUpdater });
  await f.enter();
  const metadata = verifiedUpdate();
  f.request = async () => metadata;
  await f.click('[data-check-updates]');
  await f.click('[data-download-update]');
  await f.click('[data-download-update]');
  assert.equal(calls.length, 1);
  defined(progress)({ ...metadata.asset, total: 4096, received: 2048, status: 'downloading' });
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /50%/,
  );
  defined(progress)({ ...metadata.asset, channel: 'beta', total: 4096, received: 4096 });
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /50%/,
  );
  f.ui.setVisible(false);
  f.ui.setChannel('beta');
  pending.resolve(ready(metadata.asset));
  await settle();
  await f.enter();
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-install-update]'), null);
  f.ui.setChannel('stable');
  assert.ok(f.document.querySelector<HTMLButtonElement>('[data-install-update]'));
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /ready to install/,
  );
  assert.equal(
    f.requests.filter((route) => route.startsWith('/tasks') || route.startsWith('/call')).length,
    0,
  );
});

test('explicit installation accepts ongoing calls, human control and work for native pause confirmation', async () => {
  const installed: UpdateAsset[] = [],
    nativeUpdater = {
      available: true,
      installSupported: true,
      download: async (asset: UpdateAsset) => ready(asset),
      install: async (asset: UpdateAsset) => {
        installed.push(asset);
        return { launched: true };
      },
    },
    f = fixture({
      nativeUpdater,
      installState: {
        mode: 'controller',
        call: { id: 'active' },
        takeover: true,
        provisioning: { status: 'ready' },
      },
    });
  await f.enter();
  f.request = async () => verifiedUpdate();
  await f.click('[data-check-updates]');
  await f.click('[data-download-update]');
  assert.equal(installed.length, 0);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-install-update]')).disabled,
    false,
  );
  for (const state of [
    { mode: 'controller', unsafeLocalInput: true },
    { mode: 'controller', acquiring: true },
    { mode: 'controller', provisioning: { status: 'installing' } },
    null,
  ] as const) {
    f.installState = state;
    f.render();
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-install-update]')).disabled,
      true,
    );
    await f.ui.install();
    assert.equal(installed.length, 0);
  }
  f.installState = {
    mode: 'controller',
    call: { id: 'active' },
    takeover: true,
    active: { turnId: 'vm-work' },
    queue: ['queued'],
    provisioning: { status: 'ready' },
  };
  f.render();
  await f.click('[data-install-update]');
  assert.equal(installed.length, 1);
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /Starting installer/,
  );
  const failed = fixture({
    nativeUpdater: {
      available: true,
      installSupported: true,
      download: async (asset: UpdateAsset) => ready(asset),
      install: async () => ({}),
    },
  });
  await failed.enter();
  failed.request = async () => verifiedUpdate();
  await failed.click('[data-check-updates]');
  await failed.click('[data-download-update]');
  await failed.click('[data-install-update]');
  assert.match(
    defined(failed.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /not started/,
  );
  assert.ok(failed.document.querySelector<HTMLButtonElement>('[data-install-update]'));
});

test('unverified assets, failed hashes and cross-channel metadata never enable installation', async () => {
  let downloads = 0;
  const nativeUpdater = {
      available: true,
      installSupported: true,
      download: async (asset: UpdateAsset) => {
        downloads++;
        return { ...ready(asset), sha256: 'b'.repeat(64) };
      },
      install: async () => {
        throw Error('must not install');
      },
    },
    f = fixture({ nativeUpdater });
  await f.enter();
  const verified = verifiedUpdate();
  for (const patch of [
    { url: 'https://evil.example/setup.exe' },
    { name: 'other.exe' },
    { sha256: 'bad' },
    { size: 0 },
  ] as const) {
    f.request = async () => ({ ...verified, asset: { ...verified.asset, ...patch } });
    await f.click('[data-check-updates]');
    assert.equal(f.document.querySelector<HTMLButtonElement>('[data-download-update]'), null);
  }
  f.request = async () => ({ ...verified, channel: 'beta' });
  await f.click('[data-check-updates]');
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-download-update]'), null);
  assert.equal(downloads, 0);
  f.request = async () => verified;
  await f.click('[data-check-updates]');
  await f.click('[data-download-update]');
  assert.equal(downloads, 1);
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-install-update]'), null);
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /could not be downloaded or verified/,
  );
});

test('install waits for draft preservation and rechecks pending input before native pause admission', async () => {
  const barrier = deferred<void>();
  let saved = 0,
    installed = 0,
    cleaned = 0;
  const nativeUpdater = {
      available: true,
      installSupported: true,
      download: async (asset: UpdateAsset) => ready(asset),
      install: async () => {
        installed++;
        return { launched: true };
      },
    },
    f = fixture({
      nativeUpdater,
      beforeInstall: async () => {
        saved++;
        await barrier.promise;
        return () => cleaned++;
      },
    });
  await f.enter();
  f.request = async () => verifiedUpdate();
  await f.click('[data-check-updates]');
  await f.click('[data-download-update]');
  f.installState = { mode: 'controller', unsafeLocalInput: true };
  f.render();
  await f.ui.install();
  assert.equal(saved, 0);
  assert.equal(installed, 0);
  f.installState = { mode: 'controller', call: null };
  f.render();
  const pending = f.ui.install();
  await settle();
  assert.equal(saved, 1);
  assert.equal(installed, 0);
  f.installState = { mode: 'controller', unsafeLocalInput: true };
  barrier.resolve();
  await pending;
  assert.equal(installed, 0);
  assert.equal(cleaned, 1);
  assert.ok(f.document.querySelector<HTMLButtonElement>('[data-install-update]'));
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-install-update]')).disabled,
    true,
  );
});

test('unsupported native layouts keep verified download and manual release access without an unusable Install button', async () => {
  let installs = 0,
    capabilities = 0;
  const nativeUpdater = {
      available: true,
      installSupported: false,
      ready: async () => {
        capabilities++;
      },
      download: async (asset: UpdateAsset) => ready(asset),
      install: async () => {
        installs++;
        return { launched: true };
      },
    },
    f = fixture({ nativeUpdater });
  await f.enter();
  f.request = async () => verifiedUpdate();
  await f.click('[data-check-updates]');
  await f.click('[data-download-update]');
  assert.equal(capabilities, 1);
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-install-update]'), null);
  assert.ok(f.document.querySelector<HTMLAnchorElement>('[data-update-release]'));
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-update-install-blocked]'))
      .textContent,
    /unavailable in this app layout/,
  );
  await f.ui.install();
  assert.equal(installs, 0);
});
