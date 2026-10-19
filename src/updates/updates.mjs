export const REPOSITORY_URL = 'https://github.com/Stephen-Sim/dant';
export const RELEASES_URL = REPOSITORY_URL + '/releases';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/Stephen-Sim/dant/releases/latest';
export const RELEASES_API = 'https://api.github.com/repos/Stephen-Sim/dant/releases';
export const UPDATE_CHANNELS = Object.freeze(['stable', 'beta']);
export const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*))*))?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/;
function parsedVersion(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = semver.exec(value);
  return match
    ? { parts: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') || [] }
    : null;
}
export function compareVersions(left, right) {
  const a = parsedVersion(left),
    b = parsedVersion(right);
  if (!a || !b) throw Error('Invalid application version.');
  for (let index = 0; index < 3; index++) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index],
      y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x),
      numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
const messages = {
  UPDATE_TIMEOUT: 'The update check timed out. Try again.',
  UPDATE_RATE_LIMITED: 'GitHub is limiting update checks. Try again later.',
  UPDATE_UNAVAILABLE: 'Updates could not be checked. Check your connection and try again.',
  UPDATE_INVALID_RELEASE: 'GitHub returned an invalid release. Try again later.',
  UPDATE_INVALID_CHANNEL: 'Choose Stable or Beta for updates.',
};
const failure = (code) =>
  Object.assign(Error(messages[code]), {
    code,
    status:
      code === 'UPDATE_INVALID_CHANNEL'
        ? 400
        : code === 'UPDATE_TIMEOUT'
          ? 504
          : code === 'UPDATE_RATE_LIMITED'
            ? 503
            : 502,
  });
async function boundedJson(response, maxBytes, signal) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body?.cancel?.().catch(() => {});
    throw failure('UPDATE_INVALID_RELEASE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure('UPDATE_INVALID_RELEASE');
  const chunks = [];
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw failure('UPDATE_INVALID_RELEASE');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof SyntaxError ? failure('UPDATE_INVALID_RELEASE') : error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function publishedRelease(release, channel) {
  const tag = release?.tag_name,
    version = typeof tag === 'string' ? tag.replace(/^v/, '') : null,
    parsed = parsedVersion(version);
  if (
    !release ||
    release.draft !== false ||
    typeof release.prerelease !== 'boolean' ||
    !parsed ||
    tag.includes('+') ||
    release.prerelease !== Boolean(parsed.prerelease.length) ||
    (channel === 'stable' && parsed.prerelease.length) ||
    release.html_url !== RELEASES_URL + '/tag/' + tag ||
    typeof release.published_at !== 'string' ||
    !Number.isFinite(Date.parse(release.published_at))
  )
    return null;
  const name = `dant_${version}_windows_x64_setup.exe`,
    matches = Array.isArray(release.assets)
      ? release.assets.filter((asset) => asset?.name === name)
      : [],
    candidate = matches.length === 1 ? matches[0] : null;
  const asset =
    candidate?.state === 'uploaded' &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size > 0 &&
    candidate.size <= MAX_INSTALLER_BYTES &&
    typeof candidate.digest === 'string' &&
    /^sha256:[a-fA-F0-9]{64}$/.test(candidate.digest) &&
    candidate.browser_download_url === RELEASES_URL + '/download/' + tag + '/' + name
      ? {
          version,
          channel,
          url: candidate.browser_download_url,
          sha256: candidate.digest.slice(7).toLowerCase(),
          size: candidate.size,
          name,
        }
      : null;
  return { version, releaseUrl: release.html_url, asset };
}

/** Public release metadata only. Constructing the service never contacts GitHub. */
export class UpdateService {
  constructor({
    version,
    fetchImpl = fetch,
    now = Date.now,
    timeoutMs = 10000,
    cacheMs = 60000,
    maxBytes = 2 * 1024 * 1024,
  } = {}) {
    this.version = version;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cacheMs = cacheMs;
    this.maxBytes = maxBytes;
    this.cached = new Map();
    this.pending = new Map();
    this.aborts = new Map();
    this.closed = false;
  }
  info() {
    return { version: this.version, repositoryUrl: REPOSITORY_URL, releasesUrl: RELEASES_URL };
  }
  check(channel = 'stable') {
    if (this.closed) return Promise.reject(failure('UPDATE_UNAVAILABLE'));
    if (!UPDATE_CHANNELS.includes(channel))
      return Promise.reject(failure('UPDATE_INVALID_CHANNEL'));
    const cached = this.cached.get(channel);
    if (cached && this.now() - cached.at < this.cacheMs)
      return Promise.resolve(structuredClone(cached.result));
    if (this.pending.has(channel)) return this.pending.get(channel);
    const pending = this.load(channel)
      .then((result) => {
        if (!this.closed)
          this.cached.set(channel, { at: this.now(), result: structuredClone(result) });
        return structuredClone(result);
      })
      .finally(() => {
        this.pending.delete(channel);
      });
    this.pending.set(channel, pending);
    return pending;
  }
  async load(channel) {
    if (!parsedVersion(this.version)) throw failure('UPDATE_INVALID_RELEASE');
    const controller = new AbortController();
    this.aborts.set(channel, controller);
    let timer, abort;
    const cancelled = new Promise((resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller.abort(failure('UPDATE_TIMEOUT')), this.timeoutMs);
    });
    try {
      return await Promise.race([
        cancelled,
        (async () => {
          let selected = null;
          for (let page = 1; page <= 10; page++) {
            const url =
              channel === 'stable'
                ? LATEST_RELEASE_API
                : RELEASES_API + '?per_page=100&page=' + page;
            const response = await this.fetch(url, {
              method: 'GET',
              headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'dant-update-check',
              },
              credentials: 'omit',
              redirect: 'error',
              signal: controller.signal,
            });
            if (!response.ok) {
              void response.body?.cancel?.().catch(() => {});
              throw failure(
                [403, 429].includes(response.status) ? 'UPDATE_RATE_LIMITED' : 'UPDATE_UNAVAILABLE',
              );
            }
            const body = await boundedJson(response, this.maxBytes, controller.signal);
            if (channel === 'stable') {
              selected = publishedRelease(body, channel);
              break;
            }
            if (!Array.isArray(body) || body.length > 100) throw failure('UPDATE_INVALID_RELEASE');
            for (const release of body) {
              const candidate = publishedRelease(release, channel);
              if (
                candidate &&
                (!selected || compareVersions(candidate.version, selected.version) > 0)
              )
                selected = candidate;
            }
            if (body.length < 100) break;
            if (page === 10) throw failure('UPDATE_INVALID_RELEASE');
          }
          if (!selected) throw failure('UPDATE_INVALID_RELEASE');
          return {
            currentVersion: this.version,
            latestVersion: selected.version,
            updateAvailable: compareVersions(selected.version, this.version) > 0,
            releaseUrl: selected.releaseUrl,
            checkedAt: new Date(this.now()).toISOString(),
            channel,
            asset: selected.asset,
          };
        })(),
      ]);
    } catch (error) {
      throw Object.hasOwn(messages, error?.code)
        ? failure(error.code)
        : failure('UPDATE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      if (this.aborts.get(channel) === controller) this.aborts.delete(channel);
    }
  }
  close() {
    this.closed = true;
    this.cached = null;
    for (const controller of this.aborts.values()) controller.abort(failure('UPDATE_UNAVAILABLE'));
    this.aborts.clear();
  }
}

export function installUpdateRoutes(app, updates) {
  for (const route of ['/api/version', '/api/updates'])
    app.all(route, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Update information is read-only.' });
      }
      try {
        return res.json(
          route === '/api/version'
            ? updates.info()
            : await updates.check(req.query.channel === undefined ? 'stable' : req.query.channel),
        );
      } catch (error) {
        const code = Object.hasOwn(messages, error?.code) ? error.code : 'UPDATE_UNAVAILABLE',
          safe = failure(code);
        return res.status(safe.status).json({ error: safe.message, code });
      }
    });
}
