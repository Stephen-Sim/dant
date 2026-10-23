const WINDOWS_FILE_CONCURRENCY = 1;
const DEFAULT_FILE_CONCURRENCY = 4;

/** Windows shell fixtures create many processes that share the host. */
export function testFileConcurrency(platform: NodeJS.Platform): number {
  return platform === 'win32' ? WINDOWS_FILE_CONCURRENCY : DEFAULT_FILE_CONCURRENCY;
}

export const TEST_CONCURRENCY = testFileConcurrency(process.platform);
