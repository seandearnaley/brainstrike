import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { StorageAdapter } from '@brainstrike/storage';

export type WorkspaceRootStorage = Pick<StorageAdapter, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Shared shapes for the workspace root registry and its helper modules.
 * Kept dependency-free so the read/mount/store helpers can import them
 * without a cycle back through `workspace-root-registry`.
 */

export interface SecureWorkspaceDirEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly lastModified?: number;
  readonly name: string;
  readonly size?: number;
}

export interface SecureWorkspaceRoot {
  readonly canonicalPath: string;
  close(): void;
  listDir(
    relativePath: string,
    maxEntries: number
  ): Promise<{
    readonly entries: readonly SecureWorkspaceDirEntry[];
    readonly inspected: number;
    readonly truncated: boolean;
  } | null>;
  readFile(
    relativePath: string,
    maxBytes: number
  ): Promise<
    | { readonly content: Buffer; readonly status: 'ok' }
    | { readonly status: 'not-found' | 'oversized' | 'unreadable' }
  >;
}

export interface StoredWorkspaceRoot {
  readonly addedAt: number;
  readonly path: string;
  readonly rootId: string;
}

/** A folder as the catalog records it: with the identity it was granted under. */
export interface RecordedWorkspaceRoot extends StoredWorkspaceRoot {
  readonly canonicalPath: string;
}

export interface MountedWorkspaceRoot {
  readonly canonicalPath: string;
  readonly presentationPath: string;
  readonly root: SecureWorkspaceRoot;
  readonly rootId: string;
}

export interface RootDataDeletionReservation {
  assertCurrent(): void;
  disconnect(): Promise<void>;
  readonly mounted: MountedWorkspaceRoot;
  release(): void;
  retireSources(): Promise<void>;
  run(operation: () => Promise<void>): Promise<void>;
}

export interface WorkspaceRootRegistryOptions {
  readonly createSecureRoot?: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  readonly disposeCommandSessionsForRoot: (rootId: string) => Promise<number>;
  readonly evictLspServersForRoot: (rootId: string) => Promise<void>;
  readonly getRootsCatalog: () => Promise<WorkspaceRootPort>;
  /** A roots-catalog refusal its owner expects, such as the host closing. Convergence logs it at info. */
  readonly isExpectedCatalogRefusal?: (error: unknown) => boolean;
  readonly onRootGranted?: (grantedPath: string) => void;
  readonly pathExists: (rootPath: string) => Promise<boolean>;
  /** The recent-folders ledger: the grants that let a folder reopen without the picker. */
  readonly recents: WorkspaceRootStorage;
  readonly resolveReadPath?: (requestedPath: string, canonicalRoot: string) => Promise<string>;
}
