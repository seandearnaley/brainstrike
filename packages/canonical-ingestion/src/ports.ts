import type { ChunkingRequestOptions } from '@brainstrike/chunking-worker/node';
import type { CanonicalIndexPayload } from '@brainstrike/file-import/canonical-index-publication';

export type CanonicalSourceScope =
  | { readonly kind: 'workspace'; readonly rootId: string }
  | { readonly kind: 'collection'; readonly embeddingSetId: string };

/** Actual PG catalog binding. A rootless collection never acquires a synthetic root/path. */
export interface CanonicalFileIdentity {
  readonly embeddingSetId: string | null;
  readonly fileId: string;
  readonly fileName: string;
  readonly relativePath: string | null;
  readonly rootId: string | null;
  readonly sourcePath: string | null;
}
export interface CanonicalSourceStat {
  readonly mtimeMs: number | null;
  readonly size: number;
}
export interface CanonicalSourceFile extends CanonicalFileIdentity {
  readonly stat: CanonicalSourceStat;
}
export interface CanonicalCatalogFile extends CanonicalFileIdentity {
  readonly chunksProcessed: boolean;
  readonly contentHash: string | null;
  readonly stat: CanonicalSourceStat;
}
export interface CanonicalManifestFile extends CanonicalFileIdentity {
  readonly contentHash: string;
}
export interface CanonicalOperationContext {
  readonly requestId: string;
  /** Local only. Transport adapters project explicit cancellation tokens instead. */
  readonly signal: AbortSignal;
}
export interface CanonicalScanRequest {
  readonly batchSize: number;
  readonly chunkingOptions: ChunkingRequestOptions;
  readonly forceFileIds?: readonly string[];
  readonly maxFileBytes: number;
  readonly requestId: string;
  readonly scope: CanonicalSourceScope;
}
export interface CanonicalDiscoveryCompletion {
  readonly errors: readonly string[];
  readonly full: boolean;
  readonly truncatedDirectories: readonly string[];
}
export interface CanonicalSourceBatch {
  readonly files: readonly CanonicalSourceFile[];
  readonly removed: readonly CanonicalFileIdentity[];
}
export interface CanonicalSourcePort {
  /** Stop admission and physically join every owned read, iterator and watcher. */
  close(): Promise<void>;
  discover(
    request: CanonicalScanRequest,
    context: CanonicalOperationContext
  ): AsyncGenerator<CanonicalSourceBatch, CanonicalDiscoveryCompletion>;
  read(
    file: CanonicalSourceFile,
    maxFileBytes: number,
    context: CanonicalOperationContext
  ): Promise<{ readonly content: string; readonly stat: CanonicalSourceStat }>;
}
export interface CanonicalCatalogPort<Profile = unknown> {
  /** Retain original PG source; changed content must invalidate prior chunk completion. */
  applyManagedCacheBatch(
    request: {
      readonly files: readonly (CanonicalManifestFile & {
        readonly content: string;
        readonly stat: CanonicalSourceStat;
      })[];
      readonly scope: CanonicalSourceScope;
    },
    context: CanonicalOperationContext
  ): Promise<void>;
  completeFiles(
    request: {
      readonly files: readonly {
        readonly fileId: string;
        readonly contentHash: string;
        readonly chunkCount: number;
      }[];
      readonly scope: CanonicalSourceScope;
    },
    context: CanonicalOperationContext
  ): Promise<void>;
  loadAuthorizedBatch(
    request: {
      readonly files: readonly CanonicalFileIdentity[];
      readonly scope: CanonicalSourceScope;
    },
    context: CanonicalOperationContext
  ): Promise<readonly CanonicalCatalogFile[]>;
  removeFiles(
    request: {
      readonly files: readonly CanonicalFileIdentity[];
      readonly scope: CanonicalSourceScope;
    },
    context: CanonicalOperationContext
  ): Promise<void>;
  resolveProfile(
    request: { readonly scope: CanonicalSourceScope },
    context: CanonicalOperationContext
  ): Promise<Profile>;
}
export interface CanonicalScanTicket {
  readonly generation: number;
  readonly requestId: string;
  readonly scope: CanonicalSourceScope;
  readonly storeId: string;
}
export interface CanonicalManifestResult {
  readonly changed: readonly CanonicalManifestFile[];
  readonly complete: boolean;
  readonly missing: readonly CanonicalManifestFile[];
  readonly storeId: string;
  readonly unexpected: readonly CanonicalManifestFile[];
}
export interface CanonicalScanReceipt {
  readonly reason:
    | 'complete'
    | 'partial'
    | 'aborted'
    | 'scan-errors'
    | 'truncated'
    | 'write-failed'
    | 'manifest-mismatch';
  readonly scanComplete: boolean;
  readonly ticket: CanonicalScanTicket;
}
/** The utility's existing writer/receipt owner implements this; no second receipt predicate. */
export interface CanonicalPublicationPort {
  abortScan(ticket: CanonicalScanTicket): Promise<void>;
  beginScan(request: {
    readonly requestId: string;
    readonly scope: CanonicalSourceScope;
  }): Promise<CanonicalScanTicket>;
  commitTextFile(request: {
    readonly file: CanonicalFileIdentity;
    readonly payload: CanonicalIndexPayload;
    readonly ticket: CanonicalScanTicket;
  }): Promise<void>;
  finishScan(
    request: CanonicalDiscoveryCompletion & {
      readonly aborted: boolean;
      readonly files: readonly CanonicalManifestFile[];
      readonly ticket: CanonicalScanTicket;
    }
  ): Promise<CanonicalScanReceipt>;
  removeFile(request: {
    readonly file: CanonicalFileIdentity;
    readonly ticket: CanonicalScanTicket;
  }): Promise<void>;
  verifyManifest(request: {
    readonly files: readonly CanonicalManifestFile[];
    readonly scope: CanonicalSourceScope;
  }): Promise<CanonicalManifestResult>;
}

/** Exact engine-owned profile is generic until the additive profile DTO is integrated. */
export interface CanonicalInferencePort<Profile> {
  cancel(requestId: string): Promise<void>;
  /** At most 64 ordered missing canonical chunks; the existing host relay validates the exact profile. */
  generate(request: {
    readonly chunks: readonly { readonly chunkId: string; readonly content: string }[];
    readonly profile: Profile;
    readonly requestId: string;
  }): Promise<{
    readonly profile: Profile;
    readonly requestId: string;
    readonly vectors: readonly { readonly chunkId: string; readonly vector: readonly number[] }[];
  }>;
  join(requestId: string): Promise<void>;
}
