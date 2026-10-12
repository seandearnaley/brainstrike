// @vitest-environment node
import { ParcelWatchRetirementError } from '@brainstrike/file-system/native-watch';
import type { FileSystemChange, WatcherHealthTransition } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import type { MountedWorkspaceRoot } from '../../ipc-domains/workspace-root-types';
import { createWorkspaceRootWatchOwner } from '../../ipc-domains/workspace-root-watch-owner';
import { secureRoot } from './workspace-root-registry-test-helpers';

function mounted(): MountedWorkspaceRoot {
  return {
    canonicalPath: '/workspace',
    presentationPath: '/workspace',
    root: secureRoot('/workspace'),
    rootId: '3a0e4d6a-2b1e-4cb1-b05b-27b0e9c4519a',
  };
}

function context(signal = new AbortController().signal) {
  return { requestId: 'root-watch-test', signal };
}

function fixture() {
  let onBatch: ((changes: FileSystemChange[]) => void) | undefined;
  let onHealth: ((health: WatcherHealthTransition) => void) | undefined;
  const stop = vi.fn<() => Promise<void>>(async () => undefined);
  const startWatch = vi.fn<Parameters<typeof createWorkspaceRootWatchOwner>[0]['startWatch']>(
    async (_mount, batch, health) => {
      onBatch = batch;
      onHealth = health;
      return stop;
    }
  );
  const owner = createWorkspaceRootWatchOwner({ startWatch });
  return {
    emit: (changes: FileSystemChange[]) => onBatch?.(changes),
    health: (health: WatcherHealthTransition) => onHealth?.(health),
    owner,
    startWatch,
    stop,
  };
}

describe('Application-owned mounted-root watcher sharing', () => {
  it('reports failed retry retirement to concurrent disposal without automatically retrying it', async () => {
    const f = fixture();
    const root = mounted();
    await f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context());
    const exit = Promise.withResolvers<void>();
    const failure = new Error('shared native retirement failed');
    f.stop.mockReturnValueOnce(exit.promise);
    const retry = f.owner.retry(root).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1));
    const closing = f.owner.close().catch((error: unknown) => error);
    exit.reject(failure);
    expect(await retry).toBe(failure);
    const closed: unknown = await closing;
    expect(closed).toBeInstanceOf(AggregateError);
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.startWatch).toHaveBeenCalledTimes(1);
    await f.owner.close();
    expect(f.stop).toHaveBeenCalledTimes(2);
  });

  it('joins manual native retry while retaining the visible and utility subscriptions', async () => {
    const f = fixture();
    const root = mounted();
    const visibleBatch = vi.fn();
    const utilityBatch = vi.fn();
    const utilitySignal = vi.fn();
    const visible = await f.owner.subscribe(root, visibleBatch, vi.fn(), vi.fn(), context());
    const utility = await f.owner.subscribe(root, utilityBatch, utilitySignal, vi.fn(), context());
    const exit = Promise.withResolvers<void>();
    f.stop.mockReturnValueOnce(exit.promise);
    const retry = f.owner.retry(root);
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1));
    f.emit([]);
    expect(visibleBatch).not.toHaveBeenCalled();
    expect(utilityBatch).not.toHaveBeenCalled();
    expect(f.startWatch).toHaveBeenCalledTimes(1);
    exit.resolve();
    await retry;
    expect(f.startWatch).toHaveBeenCalledTimes(2);
    expect(utilitySignal).toHaveBeenCalledExactlyOnceWith({ type: 'overflow' });
    f.emit([]);
    expect(visibleBatch).toHaveBeenCalledTimes(1);
    expect(utilityBatch).toHaveBeenCalledTimes(1);
    await visible.close();
    expect(f.stop).toHaveBeenCalledTimes(1);
    await utility.close();
    expect(f.stop).toHaveBeenCalledTimes(2);
  });

  it('joins a held manual retry before application disposal and never opens a replacement', async () => {
    const f = fixture();
    const root = mounted();
    await f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context());
    const exit = Promise.withResolvers<void>();
    f.stop.mockReturnValueOnce(exit.promise);
    const retry = f.owner.retry(root);
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = f.owner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    exit.resolve();
    await retry;
    await closing;
    expect(f.startWatch).toHaveBeenCalledTimes(1);
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('releases a rejected acquisition with no handle and allows a fresh explicit subscription', async () => {
    const f = fixture();
    const root = mounted();
    const failure = new Error('native acquisition rejected without a handle');
    f.startWatch.mockRejectedValueOnce(failure);
    await expect(f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context())).rejects.toBe(
      failure
    );
    expect(f.stop).not.toHaveBeenCalled();
    const replacement = await f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context());
    expect(f.startWatch).toHaveBeenCalledTimes(2);
    await replacement.close();
    await f.owner.close();
  });

  it('retains a typed late acquisition cleanup owner and joins its explicit retry', async () => {
    const f = fixture();
    const root = mounted();
    const exit = Promise.withResolvers<void>();
    const retire = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('acquired native handle still requires retirement'))
      .mockReturnValueOnce(exit.promise);
    const failure = new ParcelWatchRetirementError([new Error('native start timed out')], retire);
    f.startWatch.mockRejectedValueOnce(failure);
    const result: unknown = await f.owner
      .subscribe(root, vi.fn(), vi.fn(), vi.fn(), context())
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ParcelWatchRetirementError);
    if (!(result instanceof ParcelWatchRetirementError)) {
      throw new Error('Missing native retirement ownership.');
    }
    expect(retire).toHaveBeenCalledTimes(1);
    let retired = false;
    const retry = result.retire().then(() => {
      retired = true;
    });
    await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(2));
    expect(retired).toBe(false);
    await expect(f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context())).rejects.toThrow(
      'retirement'
    );
    expect(f.startWatch).toHaveBeenCalledTimes(1);
    expect(root.root.close).not.toHaveBeenCalled();
    exit.resolve();
    await retry;
    const replacement = await f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context());
    expect(f.startWatch).toHaveBeenCalledTimes(2);
    await replacement.close();
  });

  it('reports setup health once and replays failed health plus signal to a late borrower', async () => {
    const f = fixture();
    const root = mounted();
    const originalStart = f.startWatch.getMockImplementation();
    f.startWatch.mockImplementationOnce(async (...args) => {
      const stop = await originalStart?.(...args);
      if (!stop) {
        throw new Error('Missing test native disposer.');
      }
      f.health({ backend: 'fs-events', state: 'healthy', timestamp: 1 });
      return stop;
    });
    const firstHealth = vi.fn();
    const first = await f.owner.subscribe(root, vi.fn(), vi.fn(), firstHealth, context());
    expect(firstHealth).toHaveBeenCalledTimes(1);
    const failed: WatcherHealthTransition = {
      backend: 'fs-events',
      failure: {
        code: 'backend-error',
        message: 'Native watch disconnected.',
        retryable: true,
        terminal: false,
      },
      state: 'failed',
      timestamp: 2,
    };
    f.health(failed);
    const signal = vi.fn();
    const health = vi.fn();
    const late = await f.owner.subscribe(root, vi.fn(), signal, health, context());
    expect(health).toHaveBeenCalledExactlyOnceWith(failed);
    expect(signal).toHaveBeenCalledExactlyOnceWith({
      message: failed.failure?.message,
      type: 'errored',
    });
    await first.close();
    await late.close();
  });

  it('retains utility ownership when the visible listener closes and uses one native producer', async () => {
    const f = fixture();
    const root = mounted();
    const ui = vi.fn();
    const utility = vi.fn();
    const visible = await f.owner.subscribe(root, ui, vi.fn(), vi.fn(), context());
    const source = await f.owner.subscribe(root, utility, vi.fn(), vi.fn(), context());
    expect(f.startWatch).toHaveBeenCalledTimes(1);
    f.emit([]);
    expect(ui).toHaveBeenCalledTimes(1);
    expect(utility).toHaveBeenCalledTimes(1);
    await visible.close();
    f.emit([]);
    expect(ui).toHaveBeenCalledTimes(1);
    expect(utility).toHaveBeenCalledTimes(2);
    expect(f.stop).not.toHaveBeenCalled();
    await source.close();
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(root.root.close).not.toHaveBeenCalled();
  });

  it('waits for actual final unsubscribe before acknowledging or opening a replacement producer', async () => {
    const f = fixture();
    const root = mounted();
    const exit = Promise.withResolvers<void>();
    f.stop.mockReturnValueOnce(exit.promise);
    const source = await f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context());
    let closed = false;
    const closing = source.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1));
    expect(closed).toBe(false);
    await expect(f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context())).rejects.toThrow(
      'retirement'
    );
    expect(f.startWatch).toHaveBeenCalledTimes(1);
    exit.resolve();
    await closing;
    const replacement = await f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context());
    expect(f.startWatch).toHaveBeenCalledTimes(2);
    await replacement.close();
  });

  it('retains failed native retirement for explicit retry with no callbacks or duplicate producer', async () => {
    const f = fixture();
    const root = mounted();
    const failure = new Error('native watcher is still owned');
    f.stop.mockRejectedValueOnce(failure).mockResolvedValueOnce();
    const batch = vi.fn();
    const source = await f.owner.subscribe(root, batch, vi.fn(), vi.fn(), context());
    await expect(source.close()).rejects.toBe(failure);
    f.emit([]);
    expect(batch).not.toHaveBeenCalled();
    await expect(f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context())).rejects.toThrow(
      'retirement'
    );
    expect(f.startWatch).toHaveBeenCalledTimes(1);
    await source.close();
    expect(f.stop).toHaveBeenCalledTimes(2);
    const replacement = await f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context());
    await replacement.close();
  });

  it('joins a late native acquisition and its unsubscribe after subscription cancellation', async () => {
    const f = fixture();
    const ready = Promise.withResolvers<() => Promise<void>>();
    const exit = Promise.withResolvers<void>();
    f.startWatch.mockReturnValueOnce(ready.promise);
    f.stop.mockReturnValueOnce(exit.promise);
    const controller = new AbortController();
    const canceled = new Error('source subscription canceled');
    let settled = false;
    const outcome = f.owner
      .subscribe(mounted(), vi.fn(), vi.fn(), vi.fn(), context(controller.signal))
      .catch((error: unknown) => error)
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => expect(f.startWatch).toHaveBeenCalledTimes(1));
    controller.abort(canceled);
    expect(settled).toBe(false);
    ready.resolve(f.stop);
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    exit.resolve();
    expect(await outcome).toBe(canceled);
  });

  it('refuses a replacement mount while the previous exact root still owns its native watcher', async () => {
    const f = fixture();
    const original = mounted();
    const source = await f.owner.subscribe(original, vi.fn(), vi.fn(), vi.fn(), context());
    const replacement = mounted();
    await expect(
      f.owner.subscribe(replacement, vi.fn(), vi.fn(), vi.fn(), context())
    ).rejects.toThrow('mount');
    expect(f.startWatch).toHaveBeenCalledTimes(1);
    await source.close();
    const next = await f.owner.subscribe(replacement, vi.fn(), vi.fn(), vi.fn(), context());
    expect(f.startWatch).toHaveBeenCalledTimes(2);
    await next.close();
  });

  it('application disposal closes admission and joins the native owner before acknowledging', async () => {
    const f = fixture();
    const root = mounted();
    const exit = Promise.withResolvers<void>();
    f.stop.mockReturnValueOnce(exit.promise);
    const batch = vi.fn();
    await f.owner.subscribe(root, batch, vi.fn(), vi.fn(), context());
    let closed = false;
    const closing = f.owner.close().then(() => {
      closed = true;
    });
    f.emit([]);
    expect(batch).not.toHaveBeenCalled();
    await expect(f.owner.subscribe(root, vi.fn(), vi.fn(), vi.fn(), context())).rejects.toThrow();
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1));
    expect(closed).toBe(false);
    exit.resolve();
    await closing;
    expect(closed).toBe(true);
    expect(root.root.close).not.toHaveBeenCalled();
  });
});

it('forwards recoverable native overflow health and schedules the full-root source recovery signal', async () => {
  const f = fixture();
  const root = mounted();
  const health = vi.fn();
  const signal = vi.fn();
  const subscription = await f.owner.subscribe(root, vi.fn(), signal, health, context());
  const overflow = {
    backend: 'fs-events',
    failure: {
      code: 'rescan-required',
      message: 'Events were dropped by the FSEvents client. File system must be re-scanned.',
      retryable: true,
      terminal: false,
    },
    state: 'degraded',
    timestamp: 1,
  } as const;
  f.health(overflow);
  expect(health).toHaveBeenCalledExactlyOnceWith(overflow);
  expect(signal).toHaveBeenCalledExactlyOnceWith({ type: 'overflow' });
  expect(f.startWatch).toHaveBeenCalledOnce();
  expect(f.stop).not.toHaveBeenCalled();
  await subscription.close();
});
