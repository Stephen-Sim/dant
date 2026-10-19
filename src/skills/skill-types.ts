export interface SkillMetadata {
  owner: 'dant';
  name: string;
  description: string;
  files?: string[];
  updatedAt: number;
}

export interface SkillSummary {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  updatedAt: number;
}

export interface SkillSnapshot extends SkillSummary {
  instructions: string;
  files: Record<string, string>;
}

export interface SkillSaveInput {
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  enabled?: unknown;
  files?: unknown;
}

export interface LocatedSkill {
  directory: string;
  enabled: boolean;
  meta: SkillMetadata;
}
