const SENSITIVE_MEMORY_VALUE = '[sensitive value omitted]';
const sensitiveAssignment =
  /(?:"(?:password|api[ _-]?key|access[ _-]?token|secret)"|'(?:password|api[ _-]?key|access[ _-]?token|secret)'|\b(?:password|api[ _-]?key|access[ _-]?token|secret))[ \t]*[:=][ \t]*/gi;

function assignmentValueEnd(text: string, start: number, keyStart: number): number {
  const value = text.slice(start);
  if (value.startsWith(SENSITIVE_MEMORY_VALUE)) return start + SENSITIVE_MEMORY_VALUE.length;
  const quotedStart = start + (/^[ \t\r\n]*/.exec(value)?.[0].length ?? 0);
  const delimiter = ['"""', "'''", '"', "'", '`'].find((quote) =>
    text.startsWith(quote, quotedStart),
  );
  if (delimiter) {
    let cursor = quotedStart + delimiter.length;
    while (cursor < text.length) {
      if (text[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (text.startsWith(delimiter, cursor)) return cursor + delimiter.length;
      cursor++;
    }
    return text.length;
  }
  const block = /^(?:[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#[^\r\n]*)?)?\r?\n/.exec(value);
  if (block) {
    const lineStart = text.lastIndexOf('\n', keyStart - 1) + 1;
    const prefix = text.slice(lineStart, keyStart);
    if (/^[ \t]*$/.test(prefix)) {
      let cursor = start + block[0].length;
      let end = start;
      while (cursor < text.length) {
        const newline = text.indexOf('\n', cursor);
        const lineEnd = newline < 0 ? text.length : newline;
        const line = text.slice(cursor, lineEnd).replace(/\r$/, '');
        const indentation = /^[ \t]*/.exec(line)?.[0].length ?? 0;
        if (line.trim() && indentation <= prefix.length) break;
        end = lineEnd > cursor && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
        cursor = lineEnd + 1;
      }
      if (end > start) return end;
    }
  }
  return start + (/^[^\s]+/.exec(value)?.[0].length ?? 0);
}

function redactAssignments(text: string): string {
  sensitiveAssignment.lastIndex = 0;
  let cursor = 0;
  let result = '';
  for (let match = sensitiveAssignment.exec(text); match; match = sensitiveAssignment.exec(text)) {
    const start = sensitiveAssignment.lastIndex;
    const end = assignmentValueEnd(text, start, match.index);
    if (end === start) continue;
    result += text.slice(cursor, start) + SENSITIVE_MEMORY_VALUE;
    cursor = end;
    sensitiveAssignment.lastIndex = end;
  }
  return result + text.slice(cursor);
}

/** Notes remain reference data and obvious credentials never enter model context or search. */
export function sanitizeMemoryText(text: string) {
  return redactAssignments(text)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[private key omitted]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[API key omitted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, 'Bearer [token omitted]')
    .replace(/<\/?dant-memory\b/gi, '[memory delimiter]');
}
export function containsMemorySecret(text: string) {
  return (
    sanitizeMemoryText(text) !== text ||
    /\b(?:password|api[ _-]?key|access[ _-]?token|secret)\s*[:=]\s*\S+/i.test(text)
  );
}
