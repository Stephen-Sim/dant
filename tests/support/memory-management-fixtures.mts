import type { ManagedMemoryView } from '../../ui/settings/memory-management-contracts.mts';
export function managedMemoryFixture(
  conversationId = 'one',
  text = 'Actual durable notes',
): ManagedMemoryView {
  return {
    storage: 'sqlite',
    conversationId,
    revision: '1:4',
    query: '',
    offset: 0,
    total: 2,
    hasMore: false,
    identity: { text: 'Actual shared personality' },
    records: [
      { kind: 'note', id: 'working-memory.md', text, status: null, source: null, redacted: false },
      {
        kind: 'semantic',
        id: 'entry-one',
        text: 'Prefer TypeScript',
        status: 'candidate',
        source: { kind: 'inference', conversationId, workId: 'work-one' },
        redacted: false,
      },
    ],
    projects: [],
  };
}
