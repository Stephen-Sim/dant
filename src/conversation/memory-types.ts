import type { ProjectContext } from './types.ts';
import type { MemoryFileName } from './memory-constants.mts';
export interface MemoryNote {
  name: MemoryFileName;
  text: string;
}
export interface MemoryProjectInput {
  id: string;
  projectContext?: unknown;
}
export interface ProjectMemoryStore {
  readProject(conversationId: string, workId: string): ProjectContext | null;
  writeProject(conversationId: string, workId: string, context: unknown): ProjectContext;
}

export type MemoryEntryKind = 'semantic' | 'episodic';
import type { MemoryEntryStatusValue } from '../contracts/states.mts';
export type MemoryEntryStatus = MemoryEntryStatusValue;
export interface MemorySource {
  kind: 'user' | 'task' | 'inference';
  conversationId?: string;
  workId?: string;
  messageId?: string;
  at?: number;
}
export interface MemoryEntry {
  id: string;
  kind: MemoryEntryKind;
  text: string;
  key: string;
  status: MemoryEntryStatus;
  source: MemorySource;
  confidence: number | null;
  conflictsWith: string[];
  createdAt: number;
  updatedAt: number;
}
export interface MemoryEntryProposal {
  kind: MemoryEntryKind;
  text: string;
  source: MemorySource;
  key?: string;
  confidence?: number | null;
}
export interface MemorySearchResult {
  kind: 'note' | 'project' | MemoryEntryKind;
  id: string;
  text: string;
  score: number;
  updatedAt?: number;
  conversationId?: string;
  workId?: string;
}
export interface MemoryRetrievalScope {
  conversationId: string;
  workId?: string;
}
export interface MemoryRetrievalOptions {
  limit?: number;
}
export interface MemoryRetrievalReference extends MemorySearchResult {
  source?: MemorySource;
  confidence?: number | null;
}
export interface MemorySnapshot {
  revision: string;
  notes: MemoryNote[];
  entries: MemoryEntry[];
}
