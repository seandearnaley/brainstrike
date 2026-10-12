import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import { type HostRuntime, startHost } from '../src/runtime.js';

const retirement = vi.hoisted(() => ({
  beforeMetadata: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../src/record-file.js', async (original) => {
  const actual = await original<typeof import('../src/record-file.js')>();
  return {
    ...actual,
    removeOwnHostRecord: async (...args: Parameters<typeof actual.removeOwnHostRecord>) => {
      await retirement.beforeMetadata?.();
      return actual.removeOwnHostRecord(...args);
    },
  };
});

test.each([false, true])(
  'accepted close initiates retirement before held metadata, failure=%s',
  async (fail) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-close-init-'));
    const metadata = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const physical = Promise.withResolvers<void>();
    const failure = new Error('Recorded physical retirement failure');
    let host: HostRuntime | undefined;
    let retirementTask: Promise<void> | undefined;
    let repeated: Promise<void> | undefined;
    const beginClose = vi.fn(() => {
      retirementTask = physical.promise;
      void retirementTask.catch(() => undefined);
      repeated = host?.close();
    });
    retirement.beforeMetadata = () => {
      entered.resolve();
      return metadata.promise;
    };
    let lock: RootLock | undefined;
    try {
      host = await startHost(
        { lifetime: 'persistent', root },
        {
          acceptSocket: (socket) => socket.destroy(),
          acquireRoot: async () => {
            lock = await RootLock.acquire(root);
            const acquired = lock;
            return {
              close: async () => {
                await retirementTask;
                acquired.release();
              },
              lock: acquired,
            };
          },
          beginClose,
          protocolVersion: 1,
        }
      );
      const closing = host.close();
      void closing.catch(() => undefined);
      await entered.promise;
      expect(beginClose).toHaveBeenCalledOnce();
      expect(repeated).toBe(closing);
      expect(() => host?.retainRun()).toThrow('Host is closing');
      expect(RootLock.inspect(root)?.owner).toMatchObject({ pid: process.pid });
      expect(RootLock.inspect(root)?.owner.released).not.toBe(true);
      metadata.resolve();
      if (fail) {
        physical.reject(failure);
        await expect(closing).rejects.toBe(failure);
        await expect(host.closed).rejects.toBe(failure);
        expect(RootLock.inspect(root)?.owner).toMatchObject({ pid: process.pid });
        expect(RootLock.inspect(root)?.owner.released).not.toBe(true);
      } else {
        physical.resolve();
        await closing;
        await host.closed;
        expect(RootLock.inspect(root)?.owner.released).toBe(true);
      }
      expect(beginClose).toHaveBeenCalledOnce();
    } finally {
      metadata.resolve();
      physical.resolve();
      await host?.close().catch(() => undefined);
      retirement.beforeMetadata = undefined;
      lock?.release();
      await rm(root, { force: true, recursive: true });
    }
  }
);
