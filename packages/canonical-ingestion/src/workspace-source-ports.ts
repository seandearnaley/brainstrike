import type { SecureFileReadCapability } from '@brainstrike/file-system/secure-file-read';
import type { SecureWorkspaceDirEntry } from '@brainstrike/file-system/workspace-root-nodes';
import type { WorkspaceScanScope } from '@brainstrike/file-system/workspace-scan';
import type {
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  FileSystemWatchSignal,
  WatcherHealthTransition,
} from '@brainstrike/types';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils/background-indexing-policy';
import type {
  CanonicalOperationContext,
  CanonicalScanRequest,
  CanonicalSourceFile,
  CanonicalSourceScope,
  CanonicalSourceStat,
} from './ports.js';

export interface CanonicalSourceSubscription {
  close(): Promise<void>;
}

/** A borrow of main's SAME pinned mount. Paths/IDs alone cannot construct it. */
export interface CanonicalWorkspaceLease {
  readonly canonicalPath: string;
  readonly generation: string;
  listDir(
    relativePath: string,
    maxEntries: number,
    context: CanonicalOperationContext
  ): Promise<{
    readonly entries: readonly SecureWorkspaceDirEntry[];
    readonly inspected: number;
    readonly truncated: boolean;
  } | null>;
  readFile(
    relativePath: string,
    maxBytes: number,
    context: CanonicalOperationContext
  ): ReturnType<SecureFileReadCapability['readFile']>;
  /** Join/release this borrow's operations only; never close a shared mounted root. */
  retire(): Promise<void>;
  readonly rootId: string;
  readonly signal: AbortSignal;
  subscribe(
    onBatch: (
      changes: readonly FileSystemChange[],
      metadata?: FileSystemWatchBatchMetadata
    ) => void,
    onSignal: (signal: FileSystemWatchSignal) => void,
    onHealth: (health: WatcherHealthTransition) => void,
    context: CanonicalOperationContext
  ): Promise<CanonicalSourceSubscription>;
}

export interface CanonicalSourceInventoryPort {
  loadFiles(
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ): Promise<readonly CanonicalSourceFile[]>;
  readRetained(
    file: CanonicalSourceFile,
    maxFileBytes: number,
    context: CanonicalOperationContext
  ): Promise<{
    readonly content: string;
    readonly stat: CanonicalSourceStat;
  }>;
}

export interface CanonicalWorkspaceSourceDependencies {
  readonly indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  readonly inventory: CanonicalSourceInventoryPort;
  readonly lease?: CanonicalWorkspaceLease;
  readonly resolveScanScope?: (request: CanonicalScanRequest) => WorkspaceScanScope;
}
