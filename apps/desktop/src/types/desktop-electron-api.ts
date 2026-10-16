import type { ElectronVectorPreferencesBridge } from '@brainstrike/app-state/stores/vector-preferences-store';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ChunkResult } from '@brainstrike/chunking-worker';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { WebGpuAdapterAvailability } from '@brainstrike/indexing-contract';
import type {
  ContentClearCapability,
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
  EmbeddingHostCommand,
  EmbeddingHostDocumentEmbeddingsCancel,
  EmbeddingHostDocumentEmbeddingsPayload,
  EmbeddingHostDocumentEmbeddingsRequest,
  EmbeddingHostDocumentEmbeddingsResponseReport,
  EmbeddingHostQueryCancellationResult,
  EmbeddingHostQueryEmbeddingCancel,
  EmbeddingHostQueryEmbeddingPayload,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostQueryEmbeddingResponseReport,
  EmbeddingHostStatus,
} from '../embedding-host-shared';
import type {
  EmbeddingHostWebGpuAdapterRequest,
  EmbeddingHostWebGpuAdapterResponseReport,
} from '../embedding-host-webgpu-adapter';
import type { DesktopFileSystemTransport } from '../ipc-domains/file-system.contract';
import type { sourceFilesContract } from '../ipc-domains/source-files.contract';
import type { TransportBridge } from '../platform/ipc-contract';

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
  deleteRootData: (rootId: string) => Promise<void>;
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

export interface DesktopFactoryResetBridge {
  resetLocal: () => Promise<{ message?: string; success: boolean }>;
  readonly unavailableReason: string | undefined;
}

export interface VisibleDesktopElectronApi extends LayoutElectronAPI {
  content: ContentClearCapability;
  factoryReset: DesktopFactoryResetBridge;
  fileSystem: DesktopFileSystemTransport;
  getUserDataPath: () => Promise<string>;
  storage: DesktopStorageBridge;
}

/** The exact `electronAPI` surface exposed to the hidden embedding renderer. */
export interface EmbeddingHostElectronApi {
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
  cancelDocumentEmbeddings: (requestId: string) => Promise<void>;
  cancelQueryEmbedding: (requestId: string) => Promise<EmbeddingHostQueryCancellationResult>;
  documentEmbeddings: (
    payload: EmbeddingHostDocumentEmbeddingsPayload,
    options: { requestId: string }
  ) => Promise<number[][]>;
  ensureStarted: () => Promise<EmbeddingHostStatus>;
  getStatus: () => Promise<EmbeddingHostStatus>;
  onCommand: (callback: (command: EmbeddingHostCommand) => void) => () => void;
  onDocumentEmbeddingsCancel: (
    callback: (notice: EmbeddingHostDocumentEmbeddingsCancel) => void
  ) => () => void;
  onDocumentEmbeddingsRequest: (
    callback: (request: EmbeddingHostDocumentEmbeddingsRequest) => void
  ) => () => void;
  onQueryEmbeddingCancel: (
    callback: (notice: EmbeddingHostQueryEmbeddingCancel) => void
  ) => () => void;
  onQueryEmbeddingRequest: (
    callback: (request: EmbeddingHostQueryEmbeddingRequest) => void
  ) => () => void;
  onStatus: (callback: (status: EmbeddingHostStatus) => void) => () => void;
  /** The hidden host answers Main's WebGPU adapter request (BST-1993). */
  onWebgpuAdapterRequest: (
    callback: (request: EmbeddingHostWebGpuAdapterRequest) => void
  ) => () => void;
  queryEmbedding: (
    payload: EmbeddingHostQueryEmbeddingPayload,
    options?: { readonly requestId: string }
  ) => Promise<BoundaryResult<number[]>>;
  reportDocumentEmbeddingsResponse: (
    response: EmbeddingHostDocumentEmbeddingsResponseReport
  ) => void;
  reportQueryEmbeddingResponse: (response: EmbeddingHostQueryEmbeddingResponseReport) => void;
  reportStatus: (status: EmbeddingHostStatus) => void;
  reportWebgpuAdapterResponse: (response: EmbeddingHostWebGpuAdapterResponseReport) => void;
  reset: () => Promise<EmbeddingHostStatus>;
  stop: () => Promise<EmbeddingHostStatus>;
  /** The host's WebGPU detection; starts it without loading a model (BST-1993). */
  webgpuAdapter: () => Promise<WebGpuAdapterAvailability>;
}

export type EmbeddingHostRuntimeBridge = Pick<
  VisibleEmbeddingHostBridge,
  | 'onCommand'
  | 'onDocumentEmbeddingsRequest'
  | 'onDocumentEmbeddingsCancel'
  | 'reportDocumentEmbeddingsResponse'
  | 'onQueryEmbeddingRequest'
  | 'onQueryEmbeddingCancel'
  | 'reportQueryEmbeddingResponse'
  | 'reportStatus'
  | 'onWebgpuAdapterRequest'
  | 'reportWebgpuAdapterResponse'
>;

export interface VisibleDesktopCapabilities {
  chunkingHost: VisibleChunkingHostBridge;
  electronAPI: VisibleDesktopElectronApi;
  embeddingHost: VisibleEmbeddingHostBridge;
}

export interface ChunkingHostCapabilities {
  chunkingHost: ChunkingHostRuntimeBridge;
  sourceFiles: Pick<TransportBridge<typeof sourceFilesContract>, 'read'>;
}

export interface EmbeddingHostCapabilities {
  electronAPI: EmbeddingHostElectronApi;
  embeddingHost: EmbeddingHostRuntimeBridge;
}

/** Every role that actually exposes `electronAPI`; the hidden LLM host does not. */
export type DesktopRendererCapabilities = EmbeddingHostCapabilities | VisibleDesktopCapabilities;
export type DesktopElectronApi = DesktopRendererCapabilities['electronAPI'];

type ExactKeyList<Shape, Keys extends readonly (keyof Shape)[]> =
  Exclude<keyof Shape, Keys[number]> extends never ? Keys : never;

function defineExactKeys<Shape>() {
  return <const Keys extends readonly (keyof Shape)[]>(keys: ExactKeyList<Shape, Keys>) => keys;
}

const VISIBLE_ELECTRON_API_KEYS = defineExactKeys<VisibleDesktopElectronApi>()([
  'content',
  'factoryReset',
  'fileSystem',
  'getUserDataPath',
  'loadLayout',
  'saveLayout',
  'storage',
]);
const FACTORY_RESET_KEYS = defineExactKeys<DesktopFactoryResetBridge>()([
  'resetLocal',
  'unavailableReason',
]);
const EMBEDDING_ELECTRON_API_KEYS = defineExactKeys<EmbeddingHostElectronApi>()([
  'vectorPreferences',
]);
const VECTOR_PREFERENCES_KEYS = defineExactKeys<ElectronVectorPreferencesBridge>()([
  'clear',
  'read',
  'write',
]);

export type DesktopElectronApiRole = 'embedding-host' | 'visible-ui';

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
    assertExactKeys(
      'visible-ui electronAPI.factoryReset',
      visibleApi.factoryReset,
      FACTORY_RESET_KEYS
    );
    return;
  }
  const embeddingApi = api as EmbeddingHostElectronApi;
  assertExactKeys('embedding-host electronAPI', embeddingApi, EMBEDDING_ELECTRON_API_KEYS);
  assertExactKeys(
    'embedding-host electronAPI.vectorPreferences',
    embeddingApi.vectorPreferences,
    VECTOR_PREFERENCES_KEYS
  );
}
