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
  binaryFiles?: Record<string, SkillBinaryFile>;
}

export interface SkillBinaryFile {
  encoding: 'base64';
  mediaType: 'application/octet-stream';
  data: string;
}

export interface SkillAssetMetadata {
  path: string;
  mediaType: 'application/octet-stream';
  size: number;
}

export interface SkillView extends SkillSummary {
  instructions: string;
  files: Record<string, string>;
  assets?: SkillAssetMetadata[];
}

export interface SkillSaveInput {
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  enabled?: unknown;
  files?: unknown;
  binaryFiles?: unknown;
  preserveBinaryFiles?: unknown;
}

export interface LocatedSkill {
  directory: string;
  enabled: boolean;
  meta: SkillMetadata;
}
