export const MEMORY_FILES = Object.freeze([
  'README.md',
  'identity.md',
  'working-memory.md',
] as const);
export type MemoryFileName = (typeof MEMORY_FILES)[number];
export const MEMORY_MAX_BYTES = 64 * 1024;
export const MEMORY_DATABASE_FILE = 'memory.sqlite';
export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_SQLITE_BUSY_TIMEOUT_MS = 5000;
export const MEMORY_PROJECT_CACHE_LIMIT = 64;
export const MEMORY_ENTRY_MAX_BYTES = 4096;
export const MEMORY_ENTRY_LIMIT = 1000;
export const MEMORY_CONTEXT_ENTRY_LIMIT = 32;
export const MEMORY_SEARCH_QUERY_MAX_CHARS = 256;
export const MEMORY_SEARCH_TERM_LIMIT = 16;
export const MEMORY_SEARCH_RESULT_LIMIT = 50;
export const MEMORY_SEARCH_EXCERPT_CHARS = 512;
export const MEMORY_RETRIEVAL_INPUT_MAX_CHARS = 32 * 1024;
export const MEMORY_RETRIEVAL_RESULT_LIMIT = 6;
export const MEMORY_RETRIEVAL_TEXT_BUDGET = 2048;
export const MEMORY_RETRIEVAL_EXCERPT_LEAD_CHARS = 96;
export const MEMORY_RETRIEVAL_ID_MAX_CHARS = 256;
