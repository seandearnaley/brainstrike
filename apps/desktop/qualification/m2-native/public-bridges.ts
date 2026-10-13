import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { IndexSearchCapability } from '../../../../packages/indexing-contract/src/indexer-client';
import type {
  EmbeddingHostQueryEmbeddingCancel,
  EmbeddingHostQueryEmbeddingPayload,
  EmbeddingHostQueryEmbeddingRequest,
} from '../../src/embedding-host-shared';

/** Structural subset of the existing public bridges used by this isolated packet. */
export interface PublicBridges {
  readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
  readonly desktopDiagnostics?: {
    getSnapshot(): Promise<
      BoundaryResult<{
        readonly embeddingHost: {
          readonly pendingRequestCount: number;
          readonly state: string;
          readonly runtimeId: string;
        };
      }>
    >;
  };
  readonly electronAPI?: {
    readonly db: {
      query<Row = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[]
      ): Promise<{ rows: Row[] }>;
    };
    readonly storage: { getItem(key: string): Promise<string | null> };
  };
  readonly embeddingHost?: {
    queryEmbedding(payload: EmbeddingHostQueryEmbeddingPayload): Promise<BoundaryResult<number[]>>;
    onQueryEmbeddingRequest?(
      callback: (value: EmbeddingHostQueryEmbeddingRequest) => void
    ): () => void;
    onQueryEmbeddingCancel?(
      callback: (value: EmbeddingHostQueryEmbeddingCancel) => void
    ): () => void;
  };
}
