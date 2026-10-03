// @vitest-environment node

import type { Stats } from 'node:fs';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParcelWatcherModule } from '../adapters/parcel-backend.js';
import {
  ParcelSubscribeTimeoutError,
  ParcelWatchRetirementError,
  startJoinedParcelWatch,
} from '../adapters/parcel-watchers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('joined Parcel producer retirement', () => {
  it('joins native unsubscribe and an admitted event stat, without admitting queued stats', async () => {
    let callback: Parameters<ParcelWatcherModule['subscribe']>[1] | undefined;
    let releaseUnsubscribe: (() => void) | undefined;
    let releaseStat: ((value: Stats) => void) | undefined;
    const unsubscribe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseUnsubscribe = resolve;
        })
    );
    const stat = vi.spyOn(fs.promises, 'stat').mockImplementation(
      () =>
        new Promise<Stats>((resolve) => {
          releaseStat = resolve;
        })
    );
    vi.spyOn(fs.promises, 'realpath').mockResolvedValue('/workspace');
    const binding: ParcelWatcherModule = {
      getEventsSince: vi.fn(),
      subscribe: vi.fn(async (_path, onEvent) => {
        callback = onEvent;
        return { unsubscribe };
      }),
      unsubscribe: vi.fn(),
      writeSnapshot: vi.fn(),
    };
    const retire = await startJoinedParcelWatch(
      { kind: 'directory', name: 'workspace', path: '/workspace', platform: 'electron' },
      vi.fn(),
      { loadModule: async () => binding }
    );
    callback?.(null, [
      { path: '/workspace/a.ts', type: 'update' },
      { path: '/workspace/b.ts', type: 'update' },
    ]);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce());
    let settled = false;
    const retiring = Promise.resolve(retire()).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    releaseUnsubscribe?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    const metadata = { isDirectory: () => false } as Stats;
    releaseStat?.(metadata);
    await retiring;
    expect(stat).toHaveBeenCalledOnce();
    await retire();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('retains a failed unsubscribe for explicit physical retry', async () => {
    vi.spyOn(fs.promises, 'realpath').mockResolvedValue('/workspace');
    const failure = new Error('held native close failed');
    const unsubscribe = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const binding: ParcelWatcherModule = {
      getEventsSince: vi.fn(),
      subscribe: vi.fn(async () => ({ unsubscribe })),
      unsubscribe: vi.fn(),
      writeSnapshot: vi.fn(),
    };
    const retire = await startJoinedParcelWatch(
      { kind: 'directory', name: 'workspace', path: '/workspace', platform: 'electron' },
      vi.fn(),
      { loadModule: async () => binding }
    );
    await expect(retire()).rejects.toThrow('Parcel watch retirement failed');
    await retire();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('retains failed retirement of a late timed-out subscription with an explicit retry owner', async () => {
    vi.useFakeTimers();
    vi.spyOn(fs.promises, 'realpath').mockResolvedValue('/workspace');
    let acquire: ((subscription: { unsubscribe: () => Promise<void> }) => void) | undefined;
    const held = new Promise<{ unsubscribe: () => Promise<void> }>((resolve) => {
      acquire = resolve;
    });
    const binding: ParcelWatcherModule = {
      getEventsSince: vi.fn(),
      subscribe: vi.fn(() => held),
      unsubscribe: vi.fn(),
      writeSnapshot: vi.fn(),
    };
    const health = vi.fn();
    let settled = false;
    const starting = startJoinedParcelWatch(
      { kind: 'directory', name: 'workspace', path: '/workspace', platform: 'electron' },
      vi.fn(),
      { loadModule: async () => binding, onHealth: health, subscribeTimeoutMs: 1 }
    ).then(
      () => {
        throw new Error('Expected timed-out startup failure');
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(binding.subscribe).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'failed' }));
    const unsubscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('Late unsubscribe failed'))
      .mockResolvedValueOnce(undefined);
    acquire?.({ unsubscribe });
    const failure = await starting;
    expect(failure).toBeInstanceOf(ParcelWatchRetirementError);
    if (!(failure instanceof ParcelWatchRetirementError)) {
      throw new Error('Expected physical retirement owner');
    }
    await failure.retire();
    await failure.retire();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('joins admitted event work after late acquisition rejection without inventing a cleanup retry owner', async () => {
    vi.useFakeTimers();
    vi.spyOn(fs.promises, 'realpath').mockResolvedValue('/workspace');
    let callback: Parameters<ParcelWatcherModule['subscribe']>[1] | undefined;
    let rejectAcquisition: ((error: unknown) => void) | undefined;
    const acquisition = new Promise<{ unsubscribe(): Promise<void> }>((_resolve, reject) => {
      rejectAcquisition = reject;
    });
    let releaseStat: ((value: Stats) => void) | undefined;
    const stat = vi.spyOn(fs.promises, 'stat').mockImplementation(
      () =>
        new Promise<Stats>((resolve) => {
          releaseStat = resolve;
        })
    );
    const binding: ParcelWatcherModule = {
      getEventsSince: vi.fn(),
      subscribe: vi.fn((_path, onEvent) => {
        callback = onEvent;
        return acquisition;
      }),
      unsubscribe: vi.fn(),
      writeSnapshot: vi.fn(),
    };
    let settled = false;
    const starting = startJoinedParcelWatch(
      { kind: 'directory', name: 'workspace', path: '/workspace', platform: 'electron' },
      vi.fn(),
      { loadModule: async () => binding, subscribeTimeoutMs: 1000 }
    ).then(
      () => {
        throw new Error('Expected failed acquisition');
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(binding.subscribe).toHaveBeenCalledOnce());
    callback?.(null, [{ path: '/workspace/a.ts', type: 'update' }]);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1000);
    const acquisitionFailure = new Error('Late native acquisition refused.');
    rejectAcquisition?.(acquisitionFailure);
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(settled).toBe(false);
    } finally {
      releaseStat?.({ isDirectory: () => false } as Stats);
    }
    const failure = await starting;
    expect(failure).not.toBeInstanceOf(ParcelWatchRetirementError);
    expect(failure).not.toHaveProperty('retire');
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected complete startup error evidence');
    }
    expect(failure.errors).toEqual([expect.any(ParcelSubscribeTimeoutError), acquisitionFailure]);
    expect(binding.unsubscribe).not.toHaveBeenCalled();
  });
});
