import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ParcelWatchRetirementError } from '@brainstrike/file-system/native-watch';
import type { WatcherHealthTransition } from '@brainstrike/types';
import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, IpcHandler>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      registeredHandlers.set(channel, listener);
    }),
    on: vi.fn(),
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    }),
    removeListener: vi.fn(),
  },
}));

import {
  type FileSystemWatchSubscription,
  liveFileSystemWatcherCountForTest,
  liveFileSystemWatchRegistrationCountForTest,
  registerFileSystemWatchIpcHandlers,
  type StartFileSystemWatch,
} from '../../ipc-domains/file-system-watch-ipc';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import { clearWindowRoleByWebContentsId } from '../../window-role';
import {
  FakeWebContents,
  invokeEventFor,
  toDirectoryHandle,
} from './file-system-watch-ipc-test-helpers';

async function invoke(
  owner: FakeWebContents,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`Watch handler is not registered: ${channel}`);
  }
  return await handler(invokeEventFor(owner), ...args);
}

describe('shared file-system watch startup failure', () => {
  it.each(['unowned', 'retained native retirement'] as const)(
    'clears every overlapping logical registration after %s startup failure',
    async (failureKind) => {
      const owner = new FakeWebContents(1);
      const directory = await fsPromises.realpath(
        await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-watch-startup-'))
      );
      const acquisition = Promise.withResolvers<FileSystemWatchSubscription>();
      const nativeExit = Promise.withResolvers<void>();
      const cleanupFailure = new Error('native unsubscribe failed');
      const retire = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(cleanupFailure)
        .mockReturnValue(nativeExit.promise);
      let onHealth: Parameters<StartFileSystemWatch>[2] | undefined;
      const startWatch = vi.fn<StartFileSystemWatch>((_path, _changes, health) => {
        onHealth = health;
        return acquisition.promise;
      });
      const failure =
        failureKind === 'unowned'
          ? new Error('native startup failed')
          : new ParcelWatchRetirementError([new Error('late acquisition cleanup failed')], retire);
      const unregister = registerFileSystemWatchIpcHandlers({ startWatch });
      const watch = (): Promise<unknown> =>
        invoke(owner, DESKTOP_IPC_CHANNELS.files.watch, toDirectoryHandle(directory));
      const first = watch().catch((error: unknown) => error);
      let duplicate: Promise<unknown> | undefined;
      try {
        await vi.waitFor(() => expect(startWatch).toHaveBeenCalledTimes(1));
        duplicate = watch().catch((error: unknown) => error);
        await vi.waitFor(async () => {
          expect(await invoke(owner, DESKTOP_IPC_CHANNELS.files.watchTelemetry)).toMatchObject({
            duplicateRegistrations: 1,
          });
        });
        const health: WatcherHealthTransition = {
          backend: 'fs-events',
          failure: { code: 'subscribe-failed', message: 'boom', retryable: true, terminal: false },
          state: 'failed',
          timestamp: Date.now(),
        };
        onHealth?.(health);
        const watchIds = owner.healthEvents.map((event) => event.watchId);
        expect(watchIds).toHaveLength(2);
        acquisition.reject(failure);
        expect(await duplicate).toBe(failure);
        const firstFailure = await first;
        expect(firstFailure).toBeInstanceOf(Error);
        expect(liveFileSystemWatcherCountForTest()).toBe(0);
        expect(liveFileSystemWatchRegistrationCountForTest()).toBe(0);
        for (const watchId of watchIds) {
          await expect(
            invoke(owner, DESKTOP_IPC_CHANNELS.files.watchRetry, watchId)
          ).resolves.toEqual({
            reason: 'unknown',
            retried: false,
          });
        }
        if (failureKind === 'retained native retirement') {
          expect(firstFailure).toMatchObject({ errors: [failure, cleanupFailure] });
          expect(retire).toHaveBeenCalledTimes(1);
          await expect(watch()).rejects.toThrow('retirement has not completed');
          let closed = false;
          const closing = unregister().then(() => {
            closed = true;
          });
          await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(2));
          expect(closed).toBe(false);
          nativeExit.resolve();
          await closing;
        }
        owner.fireDestroyed();
        await unregister();
        expect(liveFileSystemWatchRegistrationCountForTest()).toBe(0);
      } finally {
        acquisition.reject(failure);
        nativeExit.resolve();
        await first;
        await duplicate;
        await unregister();
        clearWindowRoleByWebContentsId(owner.id);
        await fsPromises.rm(directory, { force: true, recursive: true });
      }
    }
  );
});
