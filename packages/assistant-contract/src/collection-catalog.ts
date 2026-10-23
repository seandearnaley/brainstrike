/** Existing workspace-index default, shared by desktop and the web repository. */
export const WORKSPACE_INDEX_SYSTEM_ROLE = 'workspace-index' as const;
export const WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS = {
  description: 'System-managed workspace index for assistant retrieval.',
  dimensions: 384,
  distance: 'cosine',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'local::Xenova/all-MiniLM-L6-v2',
  name: 'Workspace Index',
  systemRole: WORKSPACE_INDEX_SYSTEM_ROLE,
} as const;
