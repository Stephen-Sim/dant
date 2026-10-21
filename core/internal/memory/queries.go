package memory

// These predicates are authorization and ranking invariants, not user settings.
// Binding one named value once also keeps optional-work NULL semantics explicit.
const searchQuery = `SELECT rowid, document_key, kind, text, updated_at,
 conversation_id, work_id, bm25(memory_search), typeof(document_key), typeof(kind), typeof(text)
 FROM memory_search WHERE memory_search MATCH :expression
 AND (:conversation IS NULL OR conversation_id IS NULL OR conversation_id = :conversation)
 ORDER BY bm25(memory_search), CAST(updated_at AS INTEGER) DESC, document_key LIMIT :limit`

const retrievalQuery = `SELECT rowid, document_key, kind, text, updated_at,
 conversation_id, work_id, bm25(memory_search), typeof(document_key), typeof(kind), typeof(text)
 FROM memory_search WHERE memory_search MATCH :expression AND (
 (kind = 'note' AND document_key IN ('identity.md','working-memory.md')) OR
 (kind = 'semantic' AND conversation_id IS NULL AND work_id IS NULL) OR
 (kind IN ('semantic','episodic') AND conversation_id = :conversation
  AND (work_id IS NULL OR (work_id = :work AND :work IS NOT NULL))) OR
 (kind = 'project' AND conversation_id = :conversation AND work_id = :work AND :work IS NOT NULL)
 ) ORDER BY bm25(memory_search), document_key LIMIT :limit`
