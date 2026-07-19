/**
 * File-system watch IPC domain (fs:watch / fs:unwatch / fs:watch-event).
 *
 * Watching runs in the MAIN process (chokidar via
 * `@brainstrike/file-system/electron`, injected by ipc-handlers.ts) and pushes
 * batched `FileSystemChange[]` payloads to the OWNING renderer only — the same
 * ownership/reaper model as the notes-vault watch channels. The renderer never
 * receives Node watcher objects; it holds an opaque `watchId` and a one-way
 * push subscription (see `ElectronRendererFileSystemAdapter.watchDirectory`).
 */
import { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { FileSystemChange } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { ipcMain, type WebContents } from 'electron';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { isMockFileSystemIpcPath, resolveFileSystemIpcPath } from './file-system-ipc';

const logger = createLogger('FileSystemWatchIpc');

export interface FileSystemWatchEventPayload {
  changes: FileSystemChange[];
  watchId: string;
}

export type StartFileSystemWatch = (
  directoryPath: string,
  onChanges: (changes: FileSystemChange[]) => void
) => () => void;

export interface RegisterFileSystemWatchIpcHandlersOptions {
  /**
   * Start a recursive watcher for a validated directory path; returns a
   * disposer. Production wiring passes the chokidar-backed
   * `ElectronFileSystemAdapter.watchDirectory`; tests inject a fake.
   */
  readonly startWatch: StartFileSystemWatch;
}

interface LiveFileSystemWatcher {
  readonly ownerId: number;
  readonly stop: () => void;
}

const liveWatchers = new Map<string, LiveFileSystemWatcher>();
const reaperAttachedOwners = new Set<WebContents>();

function stopWatcher(watchId: string, entry: LiveFileSystemWatcher): void {
  try {
    entry.stop();
  } catch (error) {
    logger.warn('Failed to stop file system watcher', { error, watchId });
  }
}

function disposeFileSystemWatchersForWebContents(ownerId: number): void {
  for (const [watchId, entry] of liveWatchers) {
    if (entry.ownerId === ownerId) {
      liveWatchers.delete(watchId);
      stopWatcher(watchId, entry);
    }
  }
}

/** Stop and forget every live watcher (registrar disposer + tests). */
export function disposeAllFileSystemWatchers(): void {
  for (const [watchId, entry] of liveWatchers) {
    stopWatcher(watchId, entry);
  }
  liveWatchers.clear();
}

export function liveFileSystemWatcherCountForTest(): number {
  return liveWatchers.size;
}

function registerLiveWatcher(watchId: string, owner: WebContents, stop: () => void): void {
  liveWatchers.set(watchId, { ownerId: owner.id, stop });

  // Reap every watcher this renderer owns when it is destroyed (window closed
  // / navigated away). ONE reaper per WebContents.
  if (!reaperAttachedOwners.has(owner)) {
    reaperAttachedOwners.add(owner);
    owner.once('destroyed', () => {
      reaperAttachedOwners.delete(owner);
      disposeFileSystemWatchersForWebContents(owner.id);
    });
  }
}

export function registerFileSystemWatchIpcHandlers({
  startWatch,
}: RegisterFileSystemWatchIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.watch,
    async (event, handle: DirectoryHandle): Promise<{ watchId: string }> => {
      const owner = event.sender;
      const requestedPath = handle?.path;
      if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
        throw new Error('fs:watch requires a directory handle with a non-empty path.');
      }

      const watchId = `fs-watch-${randomUUID()}`;

      // E2E mock roots have no on-disk directory: register an inert watcher so
      // unwatch/reaping stays uniform without pointing chokidar at nothing.
      if (isMockFileSystemIpcPath(requestedPath)) {
        registerLiveWatcher(watchId, owner, () => {});
        return { watchId };
      }

      const resolvedPath = await resolveFileSystemIpcPath(requestedPath, 'watch');
      const stats = await fsPromises.stat(resolvedPath);
      if (!stats.isDirectory()) {
        throw new Error(`Cannot watch "${resolvedPath}": not a directory.`);
      }

      const stop = startWatch(resolvedPath, (changes) => {
        // Push to the OWNING renderer only (never a broadcast).
        if (owner.isDestroyed()) {
          return;
        }
        const payload: FileSystemWatchEventPayload = { changes, watchId };
        owner.send(DESKTOP_IPC_CHANNELS.files.watchEvent, payload);
      });
      registerLiveWatcher(watchId, owner, stop);
      logger.debug('Started file system watcher', { path: resolvedPath, watchId });
      return { watchId };
    }
  );

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.unwatch,
    (event, rawWatchId: unknown): void => {
      const watchId = typeof rawWatchId === 'string' ? rawWatchId : '';
      const entry = liveWatchers.get(watchId);
      if (!entry) {
        // Disposal races with the destroyed-owner reaper are normal; log only.
        logger.debug('fs:unwatch for unknown watchId — already reaped?', { watchId });
        return;
      }
      if (entry.ownerId !== event.sender.id) {
        // Same outcome as an unknown id — no ownership-leak oracle.
        logger.warn('Rejected fs:unwatch from non-owner renderer', {
          ownerId: entry.ownerId,
          requesterId: event.sender.id,
          watchId,
        });
        return;
      }
      liveWatchers.delete(watchId);
      stopWatcher(watchId, entry);
    }
  );

  return () => {
    disposeAllFileSystemWatchers();
    registry.unregisterAll();
  };
}
