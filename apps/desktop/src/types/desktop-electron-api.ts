import type { ElectronVectorPreferencesBridge } from '@brainstrike/app-state/stores/vector-preferences-store';
import type { ChunkResult } from '@brainstrike/chunking-worker';
import type { DatabaseWorkOptions, DesktopDatabaseBridge } from '@brainstrike/db';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type {
  FileSystemWatchEvent,
  IFileNode,
  RecentRootEntry,
  RootDescriptor,
  WatcherHealthEvent,
  WatcherHealthTransition,
} from '@brainstrike/types';
import type { LayoutElectronAPI } from '@brainstrike/ui';
import type {
  ChunkingHostChunkBatchRequest,
  ChunkingHostChunkFileByIdRequest,
  ChunkingHostChunkFileRequest,
  ChunkingHostProgressEvent,
  ChunkingHostRequest,
  ChunkingHostResponseReport,
  ChunkingHostStatus,
} from '../chunking-host-shared';
import type {
  EmbeddingHostBackfillInfo,
  EmbeddingHostBackfillProgress,
  EmbeddingHostBackfillRequest,
  EmbeddingHostCommand,
  EmbeddingHostQueryEmbeddingPayload,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostQueryEmbeddingResponseReport,
  EmbeddingHostStatus,
} from '../embedding-host-shared';

export interface DesktopStorageBridge {
  clear: () => Promise<void>;
  getAllKeys: () => Promise<string[]>;
  getItem: (key: string) => Promise<string | null>;
  removeItem: (key: string) => Promise<void>;
  setItem: (key: string, value: string) => Promise<void>;
}

export interface DesktopFileSystemBridge {
  addRoot: () => Promise<RootDescriptor>;
  addRootByPath: (path: string) => Promise<RootDescriptor>;
  exists: (path: string) => Promise<boolean>;
  getWatcherTelemetry: () => Promise<{
    activeWatchers: number;
    batches: number;
    cleanups: number;
    degradedTransitions: number;
    duplicateRegistrations: number;
    events: number;
    failures: number;
    healthPushes: number;
    lastSetupLatencyMs: number;
    retries: number;
    setupLatencySamples: number;
  }>;
  listRecentRoots: () => Promise<readonly RecentRootEntry[]>;
  onWatchEvent: (callback: (event: FileSystemWatchEvent) => void) => () => void;
  onWatchHealth: (callback: (event: WatcherHealthEvent) => void) => () => void;
  readDirectory: (handle: DirectoryHandle) => Promise<IFileNode[]>;
  readFile: (handle: FileHandle) => Promise<string>;
  readFileByAbsolutePath: (
    absolutePath: string,
    rootPath: string,
    rootId: string
  ) => Promise<string>;
  readFileByPath: (absolutePath: string) => Promise<string>;
  removeRoot: (rootId: string) => Promise<void>;
  requestDirectoryAccess: () => Promise<DirectoryHandle>;
  restoreLastFolder: () => Promise<DirectoryHandle | null>;
  restoreRoots: () => Promise<RootDescriptor[]>;
  retryWatch: (watchId: string) => Promise<
    | { retried: true }
    | {
        reason: 'in-flight' | 'not-failed' | 'terminal' | 'throttled' | 'unknown';
        retried: false;
        retryAfterMs?: number;
      }
  >;
  saveLastFolder: (folderPath: string) => Promise<void>;
  unwatchDirectory: (watchId: string) => Promise<void>;
  watchDirectory: (
    handle: DirectoryHandle
  ) => Promise<{ health?: WatcherHealthTransition; watchId: string }>;
}

export interface DesktopLiveQueryBridge {
  onUpdate: (callback: (payload: { id: number; results: unknown }) => void) => () => void;
  refresh: (
    payload: { id: number; limit?: number; offset?: number },
    options?: DatabaseWorkOptions
  ) => Promise<{ message?: string; success: boolean }>;
  start: (
    options: {
      key?: string;
      limit?: number;
      mode?: 'query' | 'incremental';
      offset?: number;
      params?: readonly unknown[];
      query: string;
    },
    workOptions?: DatabaseWorkOptions
  ) => Promise<{ id: number; initialResults: { rows: unknown[]; totalCount?: number } }>;
  stop: (id: number) => Promise<{ success: boolean } | undefined>;
}

type VisibleDesktopDatabaseBridge = Pick<
  DesktopDatabaseBridge,
  | 'applyManagedCacheBatch'
  | 'clearAll'
  | 'diagnostics'
  | 'exec'
  | 'insertChunksAndEnqueueEmbeddingJobs'
  | 'invalidateManagedCacheEntriesByIdentity'
  | 'ping'
  | 'query'
  | 'resetLocal'
  | 'runTransaction'
  | 'schedulerSnapshot'
  | 'test'
>;

type ChunkingHostDatabaseBridge = Pick<DesktopDatabaseBridge, 'query'>;

type EmbeddingHostDatabaseBridge = Pick<
  DesktopDatabaseBridge,
  | 'applyManagedCacheBatch'
  | 'diagnostics'
  | 'exec'
  | 'insertChunksAndEnqueueEmbeddingJobs'
  | 'invalidateManagedCacheEntriesByIdentity'
  | 'query'
  | 'runTransaction'
  | 'schedulerSnapshot'
  | 'test'
>;

/** The exact `electronAPI` surface exposed to the visible desktop renderer. */
export interface VisibleDesktopElectronApi extends LayoutElectronAPI {
  db: VisibleDesktopDatabaseBridge;
  dbLive: DesktopLiveQueryBridge;
  fileSystem: DesktopFileSystemBridge;
  getUserDataPath: () => Promise<string>;
  storage: DesktopStorageBridge;
}

/** The exact `electronAPI` surface exposed to the hidden chunking renderer. */
export interface ChunkingHostElectronApi {
  db: ChunkingHostDatabaseBridge;
}

/** The exact `electronAPI` surface exposed to the hidden embedding renderer. */
export interface EmbeddingHostElectronApi {
  db: EmbeddingHostDatabaseBridge;
  vectorPreferences: ElectronVectorPreferencesBridge;
}

export interface VisibleChunkingHostBridge {
  chunkBatch: (request: ChunkingHostChunkBatchRequest) => Promise<readonly ChunkResult[]>;
  chunkFile: (
    request: ChunkingHostChunkFileByIdRequest | ChunkingHostChunkFileRequest
  ) => Promise<ChunkResult>;
  ensureStarted: () => Promise<ChunkingHostStatus>;
  getStatus: () => Promise<ChunkingHostStatus>;
  onProgress: (callback: (progress: ChunkingHostProgressEvent) => void) => () => void;
  onRequest: (callback: (request: ChunkingHostRequest) => void) => () => void;
  onStatus: (callback: (status: ChunkingHostStatus) => void) => () => void;
  reportResponse: (response: ChunkingHostResponseReport) => void;
  reportStatus: (status: ChunkingHostStatus) => void;
  reset: () => Promise<ChunkingHostStatus>;
  stop: () => Promise<ChunkingHostStatus>;
}

export type ChunkingHostRuntimeBridge = Pick<
  VisibleChunkingHostBridge,
  'onRequest' | 'reportResponse' | 'reportStatus'
>;

export interface VisibleEmbeddingHostBridge {
  cancelAllBackfills: () => Promise<void>;
  cancelBackfill: (embeddingSetId: string) => Promise<void>;
  enqueueBackfill: (
    request: EmbeddingHostBackfillRequest
  ) => Promise<{ requestId: string } | { canceled: true }>;
  ensureStarted: () => Promise<EmbeddingHostStatus>;
  getBackfillsInFlight: () => Promise<EmbeddingHostBackfillInfo[]>;
  getStatus: () => Promise<EmbeddingHostStatus>;
  onBackfillProgress: (callback: (progress: EmbeddingHostBackfillProgress) => void) => () => void;
  onCommand: (callback: (command: EmbeddingHostCommand) => void) => () => void;
  onQueryEmbeddingRequest: (
    callback: (request: EmbeddingHostQueryEmbeddingRequest) => void
  ) => () => void;
  onStatus: (callback: (status: EmbeddingHostStatus) => void) => () => void;
  queryEmbedding: (payload: EmbeddingHostQueryEmbeddingPayload) => Promise<number[]>;
  reportQueryEmbeddingResponse: (response: EmbeddingHostQueryEmbeddingResponseReport) => void;
  reportStatus: (status: EmbeddingHostStatus) => void;
  reset: () => Promise<EmbeddingHostStatus>;
  stop: () => Promise<EmbeddingHostStatus>;
}

export type EmbeddingHostRuntimeBridge = Pick<
  VisibleEmbeddingHostBridge,
  'onCommand' | 'onQueryEmbeddingRequest' | 'reportQueryEmbeddingResponse' | 'reportStatus'
>;

export interface VisibleDesktopCapabilities {
  chunkingHost: VisibleChunkingHostBridge;
  electronAPI: VisibleDesktopElectronApi;
  embeddingHost: VisibleEmbeddingHostBridge;
}

export interface ChunkingHostCapabilities {
  chunkingHost: ChunkingHostRuntimeBridge;
  electronAPI: ChunkingHostElectronApi;
}

export interface EmbeddingHostCapabilities {
  electronAPI: EmbeddingHostElectronApi;
  embeddingHost: EmbeddingHostRuntimeBridge;
}

/** Every role that actually exposes `electronAPI`; the hidden LLM host does not. */
export type DesktopRendererCapabilities =
  | ChunkingHostCapabilities
  | EmbeddingHostCapabilities
  | VisibleDesktopCapabilities;
export type DesktopElectronApi = DesktopRendererCapabilities['electronAPI'];

type ExactKeyList<Shape, Keys extends readonly (keyof Shape)[]> =
  Exclude<keyof Shape, Keys[number]> extends never ? Keys : never;

function defineExactKeys<Shape>() {
  return <const Keys extends readonly (keyof Shape)[]>(keys: ExactKeyList<Shape, Keys>) => keys;
}

const VISIBLE_ELECTRON_API_KEYS = defineExactKeys<VisibleDesktopElectronApi>()([
  'db',
  'dbLive',
  'fileSystem',
  'getUserDataPath',
  'loadLayout',
  'saveLayout',
  'storage',
]);
const VISIBLE_DATABASE_KEYS = defineExactKeys<VisibleDesktopDatabaseBridge>()([
  'applyManagedCacheBatch',
  'clearAll',
  'diagnostics',
  'exec',
  'insertChunksAndEnqueueEmbeddingJobs',
  'invalidateManagedCacheEntriesByIdentity',
  'ping',
  'query',
  'resetLocal',
  'runTransaction',
  'schedulerSnapshot',
  'test',
]);
const CHUNKING_ELECTRON_API_KEYS = defineExactKeys<ChunkingHostElectronApi>()(['db']);
const CHUNKING_DATABASE_KEYS = defineExactKeys<ChunkingHostDatabaseBridge>()(['query']);
const EMBEDDING_ELECTRON_API_KEYS = defineExactKeys<EmbeddingHostElectronApi>()([
  'db',
  'vectorPreferences',
]);
const EMBEDDING_DATABASE_KEYS = defineExactKeys<EmbeddingHostDatabaseBridge>()([
  'applyManagedCacheBatch',
  'diagnostics',
  'exec',
  'insertChunksAndEnqueueEmbeddingJobs',
  'invalidateManagedCacheEntriesByIdentity',
  'query',
  'runTransaction',
  'schedulerSnapshot',
  'test',
]);
const VECTOR_PREFERENCES_KEYS = defineExactKeys<ElectronVectorPreferencesBridge>()([
  'clear',
  'read',
  'write',
]);

export type DesktopElectronApiRole = 'chunking-host' | 'embedding-host' | 'visible-ui';

function assertExactKeys(label: string, value: object, expectedKeys: readonly PropertyKey[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].map(String).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(
      `${label} key mismatch: expected ${expected.join(', ')}, received ${actual.join(', ')}`
    );
  }
}

/** Fail preload startup when a role's runtime bridge drifts from its exact type contract. */
export function assertDesktopElectronApiKeyParity(
  role: 'visible-ui',
  api: VisibleDesktopElectronApi
): void;
export function assertDesktopElectronApiKeyParity(
  role: 'chunking-host',
  api: ChunkingHostElectronApi
): void;
export function assertDesktopElectronApiKeyParity(
  role: 'embedding-host',
  api: EmbeddingHostElectronApi
): void;
export function assertDesktopElectronApiKeyParity(
  role: DesktopElectronApiRole,
  api: DesktopElectronApi
): void {
  if (role === 'visible-ui') {
    const visibleApi = api as VisibleDesktopElectronApi;
    assertExactKeys('visible-ui electronAPI', visibleApi, VISIBLE_ELECTRON_API_KEYS);
    assertExactKeys('visible-ui electronAPI.db', visibleApi.db, VISIBLE_DATABASE_KEYS);
    return;
  }
  if (role === 'chunking-host') {
    const chunkingApi = api as ChunkingHostElectronApi;
    assertExactKeys('chunking-host electronAPI', chunkingApi, CHUNKING_ELECTRON_API_KEYS);
    assertExactKeys('chunking-host electronAPI.db', chunkingApi.db, CHUNKING_DATABASE_KEYS);
    return;
  }
  const embeddingApi = api as EmbeddingHostElectronApi;
  assertExactKeys('embedding-host electronAPI', embeddingApi, EMBEDDING_ELECTRON_API_KEYS);
  assertExactKeys('embedding-host electronAPI.db', embeddingApi.db, EMBEDDING_DATABASE_KEYS);
  assertExactKeys(
    'embedding-host electronAPI.vectorPreferences',
    embeddingApi.vectorPreferences,
    VECTOR_PREFERENCES_KEYS
  );
}
