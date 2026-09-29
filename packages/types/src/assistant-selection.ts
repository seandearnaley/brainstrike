import type { TapestryColorName } from './tapestry-colors.js';

/** Assistant file-selection update payload shared across main, preload and renderer. */
export type AssistantSelectionMode = 'replace' | 'add' | 'remove';

export interface AssistantSelectionUpdatePayload {
  filePaths: string[];
  folderId: string;
  mode: AssistantSelectionMode;
}

// Keep these mode unions aligned with the canonical Zod schemas in
// @brainstrike/agent tools/schemas. This leaf package cannot import them
// directly without creating an agent -> types cycle.
export type AssistantWorkspaceContextSelectionMode = 'replace' | 'add' | 'remove';

export interface AssistantWorkspaceContextSelectionUpdatePayload {
  filePaths: string[];
  folderId: string;
  mode: AssistantWorkspaceContextSelectionMode;
  /** DB roots.id of the target root (diagnostic; the renderer routes by rootPath). */
  rootId?: string;
  /** Absolute path of the target root when the assistant targeted a specific root. */
  rootPath?: string;
}

export type AssistantWorkspaceTapestryUpdateMode = 'replace' | 'add' | 'clear';

export interface AssistantWorkspaceTapestryRangePayload {
  color?: TapestryColorName;
  endLine: number;
  isActive?: boolean;
  startLine: number;
}

export interface AssistantWorkspaceTapestryFileUpdatePayload {
  path: string;
  ranges: AssistantWorkspaceTapestryRangePayload[];
}

export interface AssistantWorkspaceTapestryUpdatePayload {
  folderId: string;
  mode: AssistantWorkspaceTapestryUpdateMode;
  /** DB roots.id of the target root (diagnostic; the renderer routes by rootPath). */
  rootId?: string;
  /** Absolute path of the target root when the assistant targeted a specific root. */
  rootPath?: string;
  updates: AssistantWorkspaceTapestryFileUpdatePayload[];
}
