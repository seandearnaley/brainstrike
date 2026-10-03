import type { ProfileResetLease } from '@brainstrike/host-lease';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResetDesktopApplicationDataOptions } from '../desktop-factory-reset';

const purge = vi.hoisted(() => vi.fn());
vi.mock('../desktop-factory-reset', () => ({ resetDesktopApplicationData: purge }));
vi.mock('../browser/browser-pane-host', () => ({ disposeActiveBrowserPaneViews: vi.fn() }));
vi.mock('../browser/browser-session', () => ({
  clearBrowserPaneSession: vi.fn(async () => undefined),
}));

describe('desktop reset profile ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setup() {
    let released = false;
    const clear = vi.fn(async () => undefined);
    const release = vi.fn(() => {
      released = true;
    });
    const guard: ProfileResetLease = {
      clearRootContents: clear,
      get isReleased() {
        return released;
      },
      release,
      root: '/profile',
    };
    const prepare = vi.fn(async () => guard);
    const storage = vi.fn(async () => undefined);
    const renderer = vi.fn(async () => undefined);
    const reset = vi.fn(async (lease?: ProfileResetLease) => {
      expect(lease).toBe(guard);
      await lease?.clearRootContents();
    });
    return { clear, guard, prepare, release, renderer, reset, storage };
  }

  async function handler(state: ReturnType<typeof setup>) {
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    return createDesktopFactoryResetHandler({
      cleanupLiveSubscriptionsForShutdown: async () => undefined,
      completeSuccessfulReset: state.renderer,
      logger: { error: vi.fn() },
      prepareDatabaseProfileReset: state.prepare,
      resetLocalDatabase: state.reset,
      resetPersistentStorageAfterDataDeletion: state.storage,
      runtimes: [],
      runWithDatabaseResetBarrier: async (work) => {
        await work();
      },
      userDataPath: '/userData',
      waitForDatabaseWorkSchedulerIdle: async () => undefined,
    });
  }

  function performProfileReset() {
    purge.mockImplementation(async (options: ResetDesktopApplicationDataOptions) => {
      await options.stopBackgroundRuntimes();
      await options.resetDatabaseProfile();
      expect(options.getProtectedPaths?.()).toEqual(['/profile/lock']);
      return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: ['/profile/lock'] };
    });
  }

  it('owns the profile throughout userData and storage purge, releasing before renderer replacement', async () => {
    const state = setup();
    performProfileReset();
    const storage = Promise.withResolvers<void>();
    state.storage.mockImplementation(async () => {
      await storage.promise;
    });
    state.renderer.mockImplementation(async () => {
      expect(state.guard.isReleased).toBe(true);
    });
    const run = await handler(state);
    const result = run();
    await vi.waitFor(() => expect(state.storage).toHaveBeenCalledOnce());
    expect(state.guard.isReleased).toBe(false);
    expect(state.release).not.toHaveBeenCalled();
    expect(state.renderer).not.toHaveBeenCalled();
    storage.resolve();
    await expect(result).resolves.toEqual({ success: true });
    expect(state.release).toHaveBeenCalledOnce();
    expect(state.clear).toHaveBeenCalledOnce();
  });

  it.each(['profile', 'userData', 'storage'] as const)(
    'retains the same accessible owner after %s failure for a retry',
    async (phase) => {
      const state = setup();
      performProfileReset();
      const failure = new Error(`${phase} failed`);
      if (phase === 'profile') {
        state.clear.mockRejectedValueOnce(failure);
      }
      if (phase === 'storage') {
        state.storage.mockRejectedValueOnce(failure);
      }
      if (phase === 'userData') {
        purge.mockImplementationOnce(async (options: ResetDesktopApplicationDataOptions) => {
          await options.resetDatabaseProfile();
          throw failure;
        });
      }
      const run = await handler(state);
      await expect(run()).resolves.toEqual({ message: `${phase} failed`, success: false });
      expect(state.guard.isReleased).toBe(false);
      expect(state.release).not.toHaveBeenCalled();
      expect(state.renderer).not.toHaveBeenCalled();
      await expect(run()).resolves.toEqual({ success: true });
      expect(state.prepare).toHaveBeenCalledOnce();
      expect(state.clear).toHaveBeenCalledTimes(2);
      expect(state.release).toHaveBeenCalledOnce();
    }
  );
});
