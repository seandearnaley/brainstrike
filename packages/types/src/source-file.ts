/** Authoritative file metadata and optional content projection, shared without a database runtime. */
export interface SourceFileRecord {
  readonly chunksCount: number | null;
  readonly chunksProcessed: boolean;
  readonly content: string | null;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly embeddingSetId: string | null;
  readonly fileId: string;
  readonly fileName: string;
  readonly path: string;
  readonly rootId: string | null;
  readonly stat: { readonly mtimeMs: number | null; readonly size: number };
  readonly updatedAt: string;
}
