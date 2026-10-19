import type { ProjectContext } from './types.ts';

/** Current reference memory is independent of the task's execution-state snapshot. */
export interface ProjectMemory {
  readProject(conversationId: string, workId: string): ProjectContext | null;
  writeProject(conversationId: string, workId: string, context: unknown): ProjectContext;
}
