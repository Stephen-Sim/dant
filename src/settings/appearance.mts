import { execFile } from 'node:child_process';
const FONT_INVENTORY_TIMEOUT_MS = 15000;
const MAX_FONT_INVENTORY_BYTES = 256 * 1024;
const MAX_FONT_INVENTORY_ENTRIES = 2048;
const MAX_FONT_NAME_CHARACTERS = 128;
interface FontInventoryOptions {
  platform?: NodeJS.Platform;
  run?: (
    command: string,
    arguments_: readonly string[],
    options: {
      windowsHide: boolean;
      shell: false;
      timeout: number;
      maxBuffer: number;
      encoding: 'utf8';
    },
  ) => Promise<{ stdout: string }>;
}
import { promisify } from 'node:util';
export {
  appearanceDefaults,
  appearanceKeys,
  readAppearance,
  validateAppearancePatch,
} from './appearance-settings.mts';

const execute = promisify(execFile);
const fontScript = String.raw`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName PresentationCore
$dantFontNames = @([System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source } | Sort-Object -Unique)
ConvertTo-Json -InputObject $dantFontNames -Compress`;
export async function listSystemFonts({
  platform = process.platform,
  run = execute,
}: FontInventoryOptions = {}) {
  if (platform !== 'win32') return { fonts: [], source: 'fallback' };
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', fontScript],
      {
        windowsHide: true,
        shell: false,
        timeout: FONT_INVENTORY_TIMEOUT_MS,
        maxBuffer: MAX_FONT_INVENTORY_BYTES,
        encoding: 'utf8',
      },
    );
    const values: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    if (!Array.isArray(values) || values.length > MAX_FONT_INVENTORY_ENTRIES)
      throw Error('Invalid font inventory');
    const fonts = [
      ...new Set(
        values
          .filter(
            (value): value is string =>
              typeof value === 'string' &&
              value.trim().length > 0 &&
              value.length <= MAX_FONT_NAME_CHARACTERS &&
              !/[\x00-\x1f\x7f;{}"'\\]/.test(value),
          )
          .map((value) => value.trim()),
      ),
    ].sort((a, b) => a.localeCompare(b));
    return { fonts, source: 'windows' };
  } catch {
    throw Object.assign(
      Error('Windows font list is unavailable. System fonts can still be used.'),
      { status: 503 },
    );
  }
}
