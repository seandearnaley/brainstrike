import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type {
  ContentClearCapability,
  FileSystemWatchEvent,
  IFileNode,
  RecentRootEntry,
  RootDescriptor,
  WatcherHealthEvent,
  WatcherHealthTransition,
} from '@brainstrike/types';
import type { DesktopFileSystemTransport } from '../ipc-domains/file-system.contract';

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

interface DesktopFactoryResetBridge {
  resetLocal: () => Promise<{ message?: string; success: boolean }>;
  readonly unavailableReason: string | undefined;
}

export interface VisibleDesktopElectronApi {
  content: ContentClearCapability;
  factoryReset: DesktopFactoryResetBridge;
  fileSystem: DesktopFileSystemTransport;
  getUserDataPath: () => Promise<string>;
  storage: DesktopStorageBridge;
}

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
  'storage',
]);
const FACTORY_RESET_KEYS = defineExactKeys<DesktopFactoryResetBridge>()([
  'resetLocal',
  'unavailableReason',
]);
function assertExactKeys(label: string, value: object, expectedKeys: readonly PropertyKey[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].map(String).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(
      `${label} key mismatch: expected ${expected.join(', ')}, received ${actual.join(', ')}`
    );
  }
}

/** Fail preload startup when the runtime bridge drifts from its exact type contract. */
export function assertDesktopElectronApiKeyParity(api: VisibleDesktopElectronApi): void {
  assertExactKeys('electronAPI', api, VISIBLE_ELECTRON_API_KEYS);
  assertExactKeys('electronAPI.factoryReset', api.factoryReset, FACTORY_RESET_KEYS);
}
