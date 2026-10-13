export {
  WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS,
  WORKSPACE_INDEX_SYSTEM_ROLE,
} from '@brainstrike/assistant-contract';
export type EmbeddingDistance = 'cosine' | 'l2' | 'ip';
export type EmbeddingSetSystemRole = 'workspace-index';

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
