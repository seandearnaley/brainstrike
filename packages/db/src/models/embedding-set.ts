export type EmbeddingDistance = 'cosine' | 'l2' | 'ip';
export const WORKSPACE_INDEX_SYSTEM_ROLE = 'workspace-index' as const;

export type EmbeddingSetSystemRole = typeof WORKSPACE_INDEX_SYSTEM_ROLE;

export const WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS = {
  description: 'System-managed workspace index for assistant retrieval.',
  dimensions: 1536,
  distance: 'cosine',
  modelId: 'text-embedding-3-small',
  modelKey: 'openai::text-embedding-3-small',
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
