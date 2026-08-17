import { createLogger } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge, ChangesInvalidationEvent } from '../changes-bridge';
import { useChangesLiveRefreshStore } from '../changes-live-refresh-store';
import { acquireChangesLiveRefreshSubscription } from '../use-changes-live-refresh';

function stubBridge(onInvalidated: ChangesBridge['onInvalidated']): {
  readonly listeners: ((event: ChangesInvalidationEvent) => void)[];
} {
  const listeners: ((event: ChangesInvalidationEvent) => void)[] = [];
  (window as unknown as { changes?: ChangesBridge }).changes = {
    applyRewind: vi.fn(),
    fileDiff: vi.fn(),
    finalizeRewinds: vi.fn(),
    inventory: vi.fn(),
    onInvalidated,
    redoRewind: vi.fn(),
    resolveView: vi.fn(),
    rewindPreview: vi.fn(),
  };
  return { listeners };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  useChangesLiveRefreshStore.getState().reset();
  vi.restoreAllMocks();
});

describe('acquireChangesLiveRefreshSubscription (refcounting, PR #2288 review)', () => {
  it('two concurrent holders share ONE bridge subscription; the LAST release unsubscribes; a re-acquire re-subscribes', () => {
    const unsubscribe = vi.fn();
    const onInvalidated = vi.fn(() => unsubscribe);
    stubBridge(onInvalidated);

    const releaseA = acquireChangesLiveRefreshSubscription();
    const releaseB = acquireChangesLiveRefreshSubscription();
    expect(onInvalidated).toHaveBeenCalledTimes(1);

    releaseA();
    expect(unsubscribe).not.toHaveBeenCalled();
    releaseB();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    const releaseC = acquireChangesLiveRefreshSubscription();
    expect(onInvalidated).toHaveBeenCalledTimes(2);
    releaseC();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('a release function is idempotent — double-calling cannot underflow the count', () => {
    const unsubscribe = vi.fn();
    stubBridge(vi.fn(() => unsubscribe));

    const releaseA = acquireChangesLiveRefreshSubscription();
    const releaseB = acquireChangesLiveRefreshSubscription();
    releaseA();
    releaseA();
    // B is still mounted — a double release of A must not have unsubscribed.
    expect(unsubscribe).not.toHaveBeenCalled();
    releaseB();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('delivered events reach the store through the shared listener', () => {
    const stub = stubBridge(
      vi.fn((listener: (event: ChangesInvalidationEvent) => void) => {
        stub.listeners.push(listener);
        return () => {};
      })
    );

    const release = acquireChangesLiveRefreshSubscription();
    stub.listeners[0]?.({ generation: 1, gitCommonDir: '/r/.git', repositoryRoot: '/r' });
    expect(useChangesLiveRefreshStore.getState().anyInvalidationNonce).toBe(1);
    release();
  });

  it('a THROWING bridge subscribe is logged and does not wedge the channel: after every holder releases, the next acquire retries', () => {
    const logger = createLogger('ChangesLiveRefresh');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    let attempts = 0;
    const unsubscribe = vi.fn();
    const onInvalidated = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('ipcRenderer.on exploded');
      }
      return unsubscribe;
    });
    stubBridge(onInvalidated);

    // First acquire: subscribe throws — must be LOUD, and must not escape
    // (an exception out of a useEffect body would skip React's cleanup).
    const releaseA = acquireChangesLiveRefreshSubscription();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    releaseA();

    // Back at zero holders: the next acquire attempts a fresh subscribe
    // instead of treating the failed one as live forever.
    const releaseB = acquireChangesLiveRefreshSubscription();
    expect(onInvalidated).toHaveBeenCalledTimes(2);
    releaseB();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
