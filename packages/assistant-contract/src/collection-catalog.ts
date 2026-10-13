import type { CollectionMetadata, CollectionRecord } from '@brainstrike/types';

export interface CollectionCatalogEntry extends CollectionRecord {
  readonly counts: {
    readonly files: number;
    readonly chunks: number;
    readonly unprocessedFiles: number;
  };
  readonly vectors:
    | { readonly kind: 'available'; readonly count: number }
    | { readonly kind: 'unavailable'; readonly reason: string };
}

/** The desktop collection owner. Web supplies its existing repository instead. */
export interface CollectionCatalogCapability {
  create(input: {
    readonly modelKey: string;
    readonly modelId: string;
    readonly dimensions: number;
    readonly distance: CollectionRecord['distance'];
    readonly metadata?: CollectionMetadata;
  }): Promise<CollectionRecord>;
  delete(id: string): Promise<boolean>;
  ensureWorkspaceIndex(): Promise<CollectionRecord>;
  get(id: string): Promise<CollectionRecord | null>;
  list(): Promise<readonly CollectionRecord[]>;
  snapshot(): Promise<readonly CollectionCatalogEntry[]>;
  update(id: string, metadata: CollectionMetadata): Promise<CollectionRecord | null>;
}

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
