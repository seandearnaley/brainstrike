export type EmbeddingDistance = 'cosine' | 'l2' | 'ip';
export const WORKSPACE_INDEX_SYSTEM_ROLE = 'workspace-index' as const;
export const PROMPT_LIBRARY_SYSTEM_ROLE = 'prompt-library' as const;

export type EmbeddingSetSystemRole =
  | typeof WORKSPACE_INDEX_SYSTEM_ROLE
  | typeof PROMPT_LIBRARY_SYSTEM_ROLE;

// The managed Workspace Index uses the desktop embedding host's local model so
// default indexing stays local-first and avoids hosted API costs/egress.
const WORKSPACE_INDEX_DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2' as const;
const WORKSPACE_INDEX_DEFAULT_DIMENSIONS = 384 as const;

export const WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS = {
  description: 'System-managed workspace index for assistant retrieval.',
  dimensions: WORKSPACE_INDEX_DEFAULT_DIMENSIONS,
  distance: 'cosine',
  modelId: WORKSPACE_INDEX_DEFAULT_MODEL_ID,
  modelKey: `local::${WORKSPACE_INDEX_DEFAULT_MODEL_ID}`,
  name: 'Workspace Index',
  systemRole: WORKSPACE_INDEX_SYSTEM_ROLE,
} as const satisfies {
  description: string;
  dimensions: number;
  distance: EmbeddingDistance;
  modelId: string;
  modelKey: string;
  name: string;
  systemRole: EmbeddingSetSystemRole;
};

export interface EmbeddingSet {
  category?: string;
  createdAt: string;
  description?: string;
  dimensions: number;
  distance: EmbeddingDistance;
  id: string;
  modelId: string;
  modelKey: string;
  // User-facing metadata (added in migration 011)
  name?: string;
  systemRole?: EmbeddingSetSystemRole;
  tags?: string; // Stored as comma-separated string in DB
}
