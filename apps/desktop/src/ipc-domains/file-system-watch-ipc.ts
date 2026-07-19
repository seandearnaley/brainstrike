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

/**
 * Upper bound on live watchers per renderer — a DoS guard, not a functional
 * limit (real usage is one watcher per mounted workspace root).
 */
export const MAX_FS_WATCHERS_PER_OWNER = 32;

interface LiveFileSystemWatcher {
  readonly ownerId: number;
  readonly stop: () => void;
}

const liveWatchers = new Map<string, LiveFileSystemWatcher>();
// WeakSet — never strongly retain a WebContents (matches notes-vault).
const reaperAttachedOwners = new WeakSet<WebContents>();
// Slots reserved across a watch's async setup so concurrent requests observe
// the correct per-owner total BEFORE any entry lands in liveWatchers.
const reservedWatchersByOwner = new Map<number, number>();

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

function liveWatcherCountForOwner(ownerId: number): number {
  let count = 0;
  for (const entry of liveWatchers.values()) {
    if (entry.ownerId === ownerId) {
      count += 1;
    }
  }
  return count;
}

/** Live + in-flight (reserved) watchers for an owner. */
function committedWatcherCountForOwner(ownerId: number): number {
  return liveWatcherCountForOwner(ownerId) + (reservedWatchersByOwner.get(ownerId) ?? 0);
}

function reserveWatcherSlot(ownerId: number): void {
  reservedWatchersByOwner.set(ownerId, (reservedWatchersByOwner.get(ownerId) ?? 0) + 1);
}

function releaseWatcherSlot(ownerId: number): void {
  const next = (reservedWatchersByOwner.get(ownerId) ?? 0) - 1;
  if (next <= 0) {
    reservedWatchersByOwner.delete(ownerId);
  } else {
    reservedWatchersByOwner.set(ownerId, next);
  }
}

/**
 * Reap every watcher this renderer owns when its context goes away. Attached
 * BEFORE any async setup work so a mid-setup teardown can never miss it.
 * Covers all three teardown shapes: window closed ('destroyed'), renderer
 * crash ('render-process-gone' — the WebContents survives), and main-frame
 * reload/navigation ('did-navigate' — the old context's disposers are gone).
 *
 * Because 'did-navigate' fires while the WebContents SURVIVES, `reap` must
 * remove ALL teardown listeners when any one fires — otherwise the siblings
 * of the fired event linger and the next fs:watch re-attaches a fresh set,
 * piling listeners up on one WebContents (MaxListenersExceededWarning + a
 * closure leak). Listeners are re-attached on the next fs:watch after a reap.
 */
function attachOwnerReaper(owner: WebContents): void {
  if (reaperAttachedOwners.has(owner)) {
    return;
  }
  reaperAttachedOwners.add(owner);
  const reap = (): void => {
    reaperAttachedOwners.delete(owner);
    // Remove ALL teardown listeners — a fired 'did-navigate' leaves the
    // WebContents alive, so its siblings would otherwise linger and pile up.
    owner.removeListener('destroyed', reap);
    owner.removeListener('render-process-gone', reap);
    owner.removeListener('did-navigate', reap);
    disposeFileSystemWatchersForWebContents(owner.id);
  };
  owner.on('destroyed', reap);
  owner.on('render-process-gone', reap);
  owner.on('did-navigate', reap);
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
      if (owner.isDestroyed()) {
        throw new Error('fs:watch: the requesting renderer is already destroyed.');
      }
      // Count live AND in-flight (reserved) watchers: without the reservation,
      // N concurrent requests all pass this check before any inserts, blowing
      // past the cap. The reserved slot below closes that TOCTOU window.
      if (committedWatcherCountForOwner(owner.id) >= MAX_FS_WATCHERS_PER_OWNER) {
        throw new Error(
          `fs:watch: per-renderer watcher limit reached (${MAX_FS_WATCHERS_PER_OWNER}).`
        );
      }
      // Attach the teardown reaper BEFORE any await — a renderer destroyed
      // mid-setup must still be reaped.
      attachOwnerReaper(owner);

      const watchId = `fs-watch-${randomUUID()}`;

      // E2E mock roots have no on-disk directory: register an inert watcher so
      // unwatch/reaping stays uniform without pointing chokidar at nothing.
      // No await before the insert, so no reservation is needed here.
      if (isMockFileSystemIpcPath(requestedPath)) {
        liveWatchers.set(watchId, { ownerId: owner.id, stop: () => {} });
        return { watchId };
      }

      // Hold a slot across the async setup so concurrent requests see it.
      reserveWatcherSlot(owner.id);
      try {
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
        // The awaits above raced renderer teardown: if the owner is gone, its
        // reaper has already fired — stop immediately instead of leaking.
        if (owner.isDestroyed()) {
          stop();
          throw new Error('fs:watch: the requesting renderer was destroyed during setup.');
        }
        liveWatchers.set(watchId, { ownerId: owner.id, stop });
        logger.debug('Started file system watcher', { path: resolvedPath, watchId });
        return { watchId };
      } finally {
        releaseWatcherSlot(owner.id);
      }
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
