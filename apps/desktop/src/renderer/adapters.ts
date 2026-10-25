import type {
  HostMethod,
  HostParams,
  HostResults,
  WorkspaceFileNode,
} from '@brainstrike/agent-host/protocol';
import {
  type DirectoryHandle,
  type FileHandle,
  type FileSystemAdapter,
  isDurableRootId,
  isFullyQualifiedFileSystemPath,
} from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import type {
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  FileSystemWatchSignal,
  IFileNode,
  RecentRootEntry,
  RootDescriptor,
  WatcherRetryOutcome,
  WatcherRootHealthEvent,
} from '@brainstrike/types';
import {
  type DesktopFolderPicker,
  folderPickerContract,
} from '../ipc-domains/folder-picker.contract';
import type { DesktopStorageBridge } from '../types/desktop-electron-api';
import type { DesktopHostConnection } from './desktop-host-connection';
import {
  createDesktopFileWatches,
  type DesktopFileWatches,
  wireDirectoryHandle,
} from './host-file-watches';
import { createIpcCapability } from './ipc-capability';

/** The host methods behind the Explorer's folders and reads (ADR-0029 stage 4). */
type DesktopWorkspaceFileMethod = Extract<HostMethod, `files/${string}`>;

function assertExplicitAbsoluteReadPath(value: unknown, label: string): asserts value is string {
  if (isFullyQualifiedFileSystemPath(value)) {
    return;
  }
  throw new Error(`${label} must be a non-empty absolute path`);
}

function requireFolderPicker(): DesktopFolderPicker {
  const api = window.electronAPI;
  if (!(api && 'folderPicker' in api)) {
    throw new Error('The desktop folder picker is not available in this renderer role');
  }
  return createIpcCapability(api.folderPicker, folderPickerContract);
}

/** File-size and missing-file outcomes keep their explicit codes after transport. */
function readFileOutcome(result: HostResults['files/read-file']): string {
  if (typeof result === 'string') {
    return result;
  }
  throw Object.assign(new Error(result.message), { code: result.code });
}

/** The wire handle: exactly the fields the host's schema reads. */
function wireFileHandle(handle: FileHandle): HostParams<'files/read-file'>['handle'] {
  return {
    kind: 'file',
    name: handle.name,
    path: handle.path,
    platform: handle.platform,
    ...(handle.rootFolderId === undefined ? {} : { rootFolderId: handle.rootFolderId }),
    ...(handle.rootId === undefined ? {} : { rootId: handle.rootId }),
    ...(handle.size === undefined ? {} : { size: handle.size }),
  };
}

function toFileNode(node: WorkspaceFileNode): IFileNode {
  const { children, ...fields } = node;
  return children === undefined ? { ...fields } : { ...fields, children: children.map(toFileNode) };
}

function requireStorageBridge(): DesktopStorageBridge {
  const api = window.electronAPI;
  if (!(api && 'storage' in api)) {
    throw new Error('The desktop storage capability is not available in this renderer role');
  }
  return api.storage;
}

/**
 * The desktop Explorer's file system. ADR-0029 stage 4: the agent host owns the
 * root registry, Explorer reads and folder watchers, on the frame's one host
 * connection. Only the two native folder pickers stay with Main.
 */
export class ElectronRendererFileSystemAdapter implements FileSystemAdapter {
  public readonly platform = 'electron' as const;
  /** The host's root registry is the one writer of folder records (BST-1990). */
  public readonly ownsRootRecords = true as const;
  private readonly connection: DesktopHostConnection;
  private readonly watches: DesktopFileWatches;

  constructor(connection: DesktopHostConnection) {
    this.connection = connection;
    this.watches = createDesktopFileWatches(connection);
  }

  private async request<M extends DesktopWorkspaceFileMethod>(
    method: M,
    params: HostParams<M>
  ): Promise<HostResults[M]> {
    return await (await this.connection.current()).request(method, params);
  }

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    // Main's picker records the folder as a root and as the last folder on success.
    return await requireFolderPicker().requestDirectoryAccess();
  }

  async addRoot(): Promise<RootDescriptor> {
    return await requireFolderPicker().addRoot();
  }

  /**
   * Desktop-only capability (web omits it rather than stubbing): re-mount a
   * folder the recent-roots ledger already records as granted. The host rejects
   * anything else — this is not a general open-any-path door.
   */
  async addRootByPath(rootPath: string): Promise<RootDescriptor> {
    return await this.request('files/add-root-by-path', { path: rootPath });
  }

  async listRecentRoots(): Promise<readonly RecentRootEntry[]> {
    return await this.request('files/recent-roots', {});
  }

  async restoreRoots(): Promise<RootDescriptor[]> {
    return [...(await this.request('files/restore-roots', {}))];
  }

  /**
   * Disconnect a root by RootId. The host owns the authoritative transition:
   * persistence and live status converge together, while indexed rows remain
   * retained so re-adding the folder resumes without re-indexing.
   */
  async removeRoot(rootId: string): Promise<void> {
    await this.request('files/remove-root', { rootId });
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    const nodes = await this.request('files/read-directory', {
      handle: wireDirectoryHandle(handle),
    });
    return nodes.map(toFileNode);
  }

  async readFile(handle: FileHandle): Promise<string> {
    return readFileOutcome(
      await this.request('files/read-file', { handle: wireFileHandle(handle) })
    );
  }

  /**
   * Read by absolute path within a currently mounted root. This enables loading
   * persisted tabs before their tree nodes exist without granting rootless disk
   * access.
   */
  async readFileByPath(absolutePath: string): Promise<string> {
    return readFileOutcome(await this.request('files/read-file-by-path', { path: absolutePath }));
  }

  /**
   * Explicit absolute-path capability. The renderer confines the path to
   * `rootPath`; the host exact-binds `rootId` and that path against the mounted
   * registry before authorizing the file.
   */
  async readFileByAbsolutePath(
    absolutePath: string,
    rootPath: string,
    rootId: string
  ): Promise<string> {
    assertExplicitAbsoluteReadPath(rootPath, 'Mounted root path');
    assertExplicitAbsoluteReadPath(absolutePath, 'Requested file path');
    if (!isDurableRootId(rootId)) {
      throw new Error('Mounted root identity must be a durable rootId');
    }
    return readFileOutcome(
      await this.request('files/read-file-by-absolute-path', { absolutePath, rootId, rootPath })
    );
  }

  async exists(path: string): Promise<boolean> {
    return await this.request('files/exists', { path });
  }

  async restoreLastFolder(): Promise<DirectoryHandle | null> {
    return await this.request('files/restore-last-folder', {});
  }

  /**
   * Watch a directory through the agent host's watcher. The disposer is
   * synchronous while the start is async: disposing first still stops the
   * host's watcher once it answers.
   */
  watchDirectory(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
    onSignal?: (signal: FileSystemWatchSignal) => void
  ): () => void {
    return this.watches.watchDirectory(handle, callback, onSignal);
  }

  /**
   * Watcher health capability (BST-568 slice 3). Replays the latest known
   * state per root to the new subscriber, then streams live transitions.
   */
  onWatcherHealth(callback: (event: WatcherRootHealthEvent) => void): () => void {
    return this.watches.onWatcherHealth(callback);
  }

  /** Deliberate manual retry of a failed watcher for a watched root path. */
  async retryWatcher(rootPath: string): Promise<WatcherRetryOutcome> {
    return await this.watches.retryWatcher(rootPath);
  }
}

export class ElectronRendererStorageAdapter implements StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    return requireStorageBridge().getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    return requireStorageBridge().setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    return requireStorageBridge().removeItem(key);
  }

  async clear(): Promise<void> {
    return requireStorageBridge().clear();
  }

  async getAllKeys(): Promise<string[]> {
    return requireStorageBridge().getAllKeys();
  }
}
