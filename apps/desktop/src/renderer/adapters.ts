import {
  type DirectoryHandle,
  type FileHandle,
  type FileSystemAdapter,
  isDurableRootId,
  isFullyQualifiedFileSystemPath,
} from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
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
import { fileSystemContract } from '../ipc-domains/file-system.contract';
import type { DesktopFileSystemBridge } from '../types/desktop-electron-api';
import { type DesktopFileReads, resolveDesktopFileReads } from './host-file-reads';
import { resolveDesktopFileWatches } from './host-file-watches';
import { createIpcCapability } from './ipc-capability';

const logger = createLogger('ElectronRendererAdapters');

function assertExplicitAbsoluteReadPath(value: unknown, label: string): asserts value is string {
  if (isFullyQualifiedFileSystemPath(value)) {
    return;
  }
  throw new Error(`${label} must be a non-empty absolute path`);
}

function getFileSystemBridge(): DesktopFileSystemBridge | undefined {
  const api = window.electronAPI;
  if (!(api && 'fileSystem' in api)) {
    return;
  }
  return createIpcCapability(api.fileSystem, fileSystemContract);
}

function requireFileSystemBridge(): DesktopFileSystemBridge {
  const fileSystem = getFileSystemBridge();
  if (!fileSystem) {
    throw new Error('The desktop file-system capability is not available in this renderer role');
  }
  return fileSystem;
}

function requireFileReads(): DesktopFileReads {
  const reads = resolveDesktopFileReads();
  if (!reads) {
    throw new Error('Workspace file reads need the agent host, which this window does not have');
  }
  return reads;
}

export class ElectronRendererFileSystemAdapter implements FileSystemAdapter {
  public readonly platform = 'electron' as const;
  /** Main's root registry is the one writer of folder records (BST-1990). */
  public readonly ownsRootRecords = true as const;

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    // Main owns the last-folder preference: fs:requestDirectoryAccess routes
    // through the registry's addRoot, which persists it on success.
    return requireFileSystemBridge().requestDirectoryAccess();
  }

  async addRoot(): Promise<RootDescriptor> {
    return requireFileSystemBridge().addRoot();
  }

  /**
   * Desktop-only capability (web omits it rather than stubbing): re-mount a
   * folder main's recent-roots ledger already records as granted. Main rejects
   * anything else — this is not a general open-any-path door.
   */
  async addRootByPath(rootPath: string): Promise<RootDescriptor> {
    return requireFileSystemBridge().addRootByPath(rootPath);
  }

  async listRecentRoots(): Promise<readonly RecentRootEntry[]> {
    return requireFileSystemBridge().listRecentRoots();
  }

  async restoreRoots(): Promise<RootDescriptor[]> {
    return requireFileSystemBridge().restoreRoots();
  }

  /**
   * Disconnect a root by RootId. Main owns the authoritative transition:
   * persistence and DB live-status converge together, while indexed rows remain
   * retained so re-adding the folder resumes without re-indexing.
   */
  async removeRoot(rootId: string): Promise<void> {
    return requireFileSystemBridge().removeRoot(rootId);
  }

  /** The agent host lists a live root's directory (ADR-0029 stage 4). */
  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    return requireFileReads().readDirectory(handle);
  }

  async readFile(handle: FileHandle): Promise<string> {
    return requireFileReads().readFile(handle);
  }

  /**
   * Read by absolute path within a live root. This enables loading persisted
   * tabs before their tree nodes exist without granting rootless disk access.
   */
  async readFileByPath(absolutePath: string): Promise<string> {
    return requireFileReads().readFile({ path: absolutePath });
  }

  /**
   * Explicit absolute-path capability. The renderer confines the path to
   * `rootPath`; the agent host exact-binds `rootId` and that path against its
   * live roots before authorizing the file.
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
    return requireFileReads().readFile({ path: absolutePath }, { path: rootPath, rootId });
  }

  async exists(path: string): Promise<boolean> {
    return requireFileReads().exists(path);
  }

  async restoreLastFolder(): Promise<DirectoryHandle | null> {
    return requireFileSystemBridge().restoreLastFolder();
  }

  /**
   * Watch a directory through the agent host (ADR-0029 stage 4): the host runs
   * the `fs.watch` root watcher and pushes batches and health on this window's
   * host connection. A window without the agent-host capability warn-logs and
   * returns a no-op disposer: the folder is visibly unwatched, never polled.
   */
  watchDirectory(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
    onSignal?: (signal: FileSystemWatchSignal) => void
  ): () => void {
    const watches = resolveDesktopFileWatches();
    if (!watches) {
      logger.warn('watchDirectory: this window has no agent host; folder is unwatched', {
        path: handle.path,
      });
      return () => {};
    }
    return watches.watchDirectory(handle, callback, onSignal);
  }

  /**
   * Watcher health (BST-568 slice 3). Replays the latest known state per root
   * to the new subscriber, then streams live transitions.
   */
  onWatcherHealth(callback: (event: WatcherRootHealthEvent) => void): () => void {
    return resolveDesktopFileWatches()?.onWatcherHealth(callback) ?? (() => {});
  }

  /** Deliberate manual retry of a failed watcher for a watched root path. */
  async retryWatcher(rootPath: string): Promise<WatcherRetryOutcome> {
    const watches = resolveDesktopFileWatches();
    if (!watches) {
      return { reason: 'unsupported', retried: false };
    }
    return await watches.retryWatcher(rootPath);
  }
}
