export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  hash: string;
  guestPath: string;
  sourcePath?: string;
  transcription?: string;
}

export interface AttachmentInput {
  name?: unknown;
  data?: unknown;
  type?: unknown;
}

export interface OutputFile {
  hash: string;
  data: Buffer;
  name: string;
}

export interface DeliverableBaseline {
  valid: boolean;
  hashes: Map<string, string>;
}

export interface DeliverableOwnership {
  workspace?: string;
  conversationId?: string;
  messageId?: string | null | undefined;
  turnId?: string | null | undefined;
}

export interface DeliverableArchiveInput extends DeliverableOwnership {
  baseline?: DeliverableBaseline | null | undefined;
  outputDir: string;
  explicitPaths?: readonly string[];
  excludePaths?: readonly string[];
  text?: string;
  onlyExplicit?: boolean;
}
