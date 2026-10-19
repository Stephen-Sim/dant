import type { Express } from 'express';
import type { MemoryStore } from './memory.mts';
export interface MemoryViewEngine {
  store: { state: { conversationId: string } };
  memory: Pick<MemoryStore, 'context'>;
  redact: (text: string) => string;
}
import { DANT_IDENTITY_INSTRUCTIONS } from './identity.mts';

// These are the same public identity and durable references supplied to text
// and voice. Runtime instructions, credentials and MCP configuration stay out.
export function currentMemoryView(engine: MemoryViewEngine) {
  return {
    conversationId: engine.store.state.conversationId,
    readOnly: true,
    identity: { text: DANT_IDENTITY_INSTRUCTIONS },
    memory: { text: engine.redact(engine.memory.context()) },
  };
}

export function installMemoryViewRoutes(app: Express, engine: MemoryViewEngine) {
  app.get('/api/memory/view', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(currentMemoryView(engine));
    } catch {
      res
        .status(503)
        .json({ error: 'The current memory could not be read. Try again after reconnecting.' });
    }
  });
  app.all('/api/memory/view', (_req, res) =>
    res.status(405).json({ error: 'This memory view is read-only.' }),
  );
}
