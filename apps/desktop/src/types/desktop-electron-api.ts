import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type {
  ContentClearCapability,
  IFileNode,
  RecentRootEntry,
  RootDescriptor,
} from '@brainstrike/types';
import type { DesktopFileSystemTransport } from '../ipc-domains/file-system.contract';

/** E2E only: seeds and clears Main's workspace ledgers. Absent outside test mode. */
export interface DesktopWorkspaceLedgersForE2e {
  clearLedgersForE2e?: () => Promise<void>;
  seedLedgerForE2e?: (key: string, value: string) => Promise<void>;
}

export interface DesktopFileSystemBridge {
  addRoot: () => Promise<RootDescriptor>;
  addRootByPath: (path: string) => Promise<RootDescriptor>;
  deleteRootData: (rootId: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  listRecentRoots: () => Promise<readonly RecentRootEntry[]>;
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
  saveLastFolder: (folderPath: string) => Promise<void>;
}

interface DesktopFactoryResetBridge {
  resetLocal: () => Promise<{ message?: string; success: boolean }>;
  readonly unavailableReason: string | undefined;
}

export interface VisibleDesktopElectronApi {
  content: ContentClearCapability;
  factoryReset: DesktopFactoryResetBridge;
  fileSystem: DesktopFileSystemTransport & DesktopWorkspaceLedgersForE2e;
  getUserDataPath: () => Promise<string>;
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
