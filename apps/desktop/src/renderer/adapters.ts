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
import { type DesktopFileReads, resolveDesktopFileReads } from './host-file-reads';
import { resolveDesktopFileWatches } from './host-file-watches';
import { type DesktopWorkspaceRoots, resolveDesktopWorkspaceRoots } from './host-workspace-roots';

const logger = createLogger('ElectronRendererAdapters');

function assertExplicitAbsoluteReadPath(value: unknown, label: string): asserts value is string {
  if (isFullyQualifiedFileSystemPath(value)) {
    return;
  }
  throw new Error(`${label} must be a non-empty absolute path`);
}

function requireWorkspaceRoots(): DesktopWorkspaceRoots {
  const roots = resolveDesktopWorkspaceRoots();
  if (!roots) {
    throw new Error('Workspace folders need the agent host, which this window does not have');
  }
  return roots;
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
  /** The agent host's root registry is the one writer of folder records (ADR-0029 stage 4). */
  public readonly ownsRootRecords = true as const;

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    return (await requireWorkspaceRoots().pickRoot()).handle;
  }

  async addRoot(): Promise<RootDescriptor> {
    return requireWorkspaceRoots().pickRoot();
  }

  /**
   * Desktop-only capability (web omits it rather than stubbing): re-mount a
   * folder the host's recent-folders ledger records as granted, or a managed
   * worktree. The host rejects anything else: this is not an open-any-path door.
   */
  async addRootByPath(rootPath: string): Promise<RootDescriptor> {
    return requireWorkspaceRoots().addRootByPath(rootPath);
  }

  /** The host closes the other open folders in the same write (ADR-0034). */
  async openRoot(rootPath?: string): Promise<RootDescriptor> {
    return requireWorkspaceRoots().openRoot(rootPath);
  }

  async listRecentRoots(): Promise<readonly RecentRootEntry[]> {
    return requireWorkspaceRoots().listRecentRoots();
  }

  async restoreRoots(): Promise<RootDescriptor[]> {
    return requireWorkspaceRoots().restoreRoots();
  }

  /**
   * Disconnect a root by RootId. The host owns the transition: the folder closes
   * and disconnects together, while indexed rows remain so re-adding the folder
   * resumes without re-indexing.
   */
  async removeRoot(rootId: string): Promise<void> {
    return requireWorkspaceRoots().removeRoot(rootId);
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
