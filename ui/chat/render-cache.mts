// Cache only the final output of the existing Markdown parser and sanitizer.
// Message text is the complete key: this pipeline has no language, token or
// connection-dependent substitutions. Nothing is persisted outside the renderer.
export const MARKDOWN_CACHE_ENTRY_LIMIT = 2_048;
export const MARKDOWN_CACHE_CHARACTER_LIMIT = 4 * 1024 * 1024;
const TIME_FORMAT_CACHE_ENTRY_LIMIT = 64;
const timeFormats = new Map<string, Intl.DateTimeFormat>();
let currentTimeZone: string | null = null,
  currentOffset: number | null = null,
  resetTimeZoneQueued = false;
function systemTimeZone(): string {
  const offset = new Date().getTimezoneOffset();
  if (currentTimeZone === null || offset !== currentOffset) {
    currentTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    currentOffset = offset;
  }
  // One timezone lookup serves a synchronous render batch. The next event-loop
  // turn observes a changed OS zone, including zones with the same current offset.
  if (!resetTimeZoneQueued) {
    resetTimeZoneQueued = true;
    queueMicrotask(() => {
      currentTimeZone = null;
      currentOffset = null;
      resetTimeZoneQueued = false;
    });
  }
  return currentTimeZone;
}

export function createMarkdownCache(render: (text: string) => string) {
  const entries = new Map<string, string>();
  let characters = 0;
  return {
    render(text: string): string {
      const cached = entries.get(text);
      if (cached !== undefined) {
        entries.delete(text);
        entries.set(text, cached);
        return cached;
      }
      const html = render(text),
        size = text.length + html.length;
      if (size > MARKDOWN_CACHE_CHARACTER_LIMIT) return html;
      while (
        entries.size >= MARKDOWN_CACHE_ENTRY_LIMIT ||
        characters + size > MARKDOWN_CACHE_CHARACTER_LIMIT
      ) {
        const oldest = entries.entries().next().value;
        if (!oldest) break;
        entries.delete(oldest[0]);
        characters -= oldest[0].length + oldest[1].length;
      }
      entries.set(text, html);
      characters += size;
      return html;
    },
    clear() {
      entries.clear();
      characters = 0;
    },
  };
}

export function formatMessageTime(value: Date, locale: string, full = false): string {
  const timeZone = systemTimeZone(),
    key = locale + ':' + full + ':' + timeZone;
  let formatter = timeFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(
      locale,
      full
        ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }
        : { hour: '2-digit', minute: '2-digit', timeZone },
    );
    if (timeFormats.size >= TIME_FORMAT_CACHE_ENTRY_LIMIT) {
      const oldest = timeFormats.keys().next().value;
      if (oldest !== undefined) timeFormats.delete(oldest);
    }
    timeFormats.set(key, formatter);
  }
  return formatter.format(value);
}
