// @vitest-environment jsdom
/**
 * BST-2515 (ADR-0015): Factory Reset reloads once every clear a page or the reopened profile can
 * read has finished. Chromium's network history (HSTS, alt-svc) reaches disk on Chromium's own
 * schedule: its write runs at background priority, which a busy Mac can starve for minutes. When
 * that clear fails, the person is told, whenever it fails.
 */
import { createLogger } from '@brainstrike/logging';
import type { ResetOutcome } from '@brainstrike/types';
import { resetToastStore, Toaster } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFactoryResetOutcomeNotice } from '../renderer/use-factory-reset-outcome-notice';
import type { VisibleDesktopElectronApi } from '../types/desktop-electron-api';

const fixture = vi.hoisted(() => {
  /**
   * An Electron session as Chromium runs it: `clearData` calls run one at a time, and one that
   * clears the cache type also clears the network history, so it waits for that write to disk.
   */
  const chromiumSession = () => {
    const networkHistoryWrite = Promise.withResolvers<void>();
    let previous: Promise<unknown> = Promise.resolve();
    const clearData = vi.fn((options?: { readonly dataTypes?: readonly string[] }) => {
      const clearsCache = options?.dataTypes === undefined || options.dataTypes.includes('cache');
      const run = previous.then(() => (clearsCache ? networkHistoryWrite.promise : undefined));
      previous = run.catch(() => undefined);
      return run;
    });
    return {
      clearAuthCache: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      clearCodeCaches: vi.fn(async (_options: object) => undefined),
      clearData,
      clearHostResolverCache: vi.fn(async () => undefined),
      clearSharedDictionaryCache: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
      networkHistoryWrite,
    };
  };
  type ChromiumSession = ReturnType<typeof chromiumSession>;
  const sessions: Record<'agent' | 'app' | 'pane', ChromiumSession | null> = {
    agent: null,
    app: null,
    pane: null,
  };
  const owned = (name: keyof typeof sessions): ChromiumSession => {
    const found = sessions[name];
    if (found === null) {
      throw new Error(`No ${name} session`);
    }
    return found;
  };
  return { chromiumSession, owned, sessions };
});
const { owned } = fixture;

vi.mock('electron', () => ({
  session: {
    get defaultSession() {
      return fixture.owned('app');
    },
    fromPartition: (partition: string) =>
      fixture.owned(partition === 'browser-pane-agent' ? 'agent' : 'pane'),
  },
}));
vi.mock('../browser/browser-pane-host', () => ({ disposeActiveBrowserPaneViews: vi.fn() }));
// The purge itself is not under test: it stops the runtimes, the session clear among them, and
// retires the profile, as the real one does before it deletes anything.
vi.mock('../desktop-factory-reset', () => ({
  resetDesktopApplicationData: async (options: {
    readonly resetDatabaseProfile: () => Promise<void>;
    readonly stopBackgroundRuntimes: () => Promise<void>;
  }) => {
    await options.stopBackgroundRuntimes();
    await options.resetDatabaseProfile();
    return {};
  },
}));

beforeEach(() => {
  vi.restoreAllMocks();
  fixture.sessions.agent = fixture.chromiumSession();
  fixture.sessions.app = fixture.chromiumSession();
  fixture.sessions.pane = fixture.chromiumSession();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'electronAPI');
  resetToastStore();
});

/** Settles once every callback already queued has run: no time passes. */
const queuedWork = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The replacement window: it shows what Main tells it about the reset, as the app's does. */
function ReplacementWindow() {
  useFactoryResetOutcomeNotice();
  return <Toaster />;
}

/**
 * Main's reset owner, with every window it pushes to reached through the `factoryReset` bridge as
 * the preload exposes it. `replace` stands in for loading the replacement window.
 */
async function factoryReset(replace: () => Promise<void> = async () => undefined) {
  const listeners = new Set<(outcome: ResetOutcome) => void>();
  const published: ResetOutcome[] = [];
  const reload = vi.fn(async (_signal: AbortSignal, _mode: string) => {
    await replace();
  });
  const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
  const handler = createDesktopFactoryResetHandler({
    completeSuccessfulReset: reload,
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
    prepareDatabaseProfileReset: async () => ({
      clearRootContents: async () => undefined,
      isReleased: false,
      release: () => undefined,
      root: '/mock/profile',
    }),
    publishResetOutcome: (outcome) => {
      published.push(outcome);
      for (const listener of listeners) {
        listener(outcome);
      }
    },
    resetLocalDatabase: async () => undefined,
    runtimes: [],
    sessionDataPath: '/mock/userData/session-data',
    userDataPath: '/mock/userData',
  });
  window.electronAPI = {
    factoryReset: {
      onResetOutcome: (listener: (outcome: ResetOutcome) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      resetLocal: () => handler.reset(),
      takeResetOutcome: async () => handler.takeResetOutcome(),
      unavailableReason: undefined,
    },
  } as unknown as VisibleDesktopElectronApi;
  return { handler, published, reload };
}

/** Starts the reset and reads its answer once the work already queued has run. */
async function answerOf(reset: Promise<unknown>): Promise<unknown> {
  let answer: unknown = 'still waiting';
  void reset.then((result) => {
    answer = result;
  });
  await queuedWork();
  return answer;
}

const NOT_CLEARED = 'Factory reset could not clear some browsing data';

it('reloads the window while Chromium still writes the cleared network history to disk', async () => {
  const { handler, reload } = await factoryReset();

  expect(await answerOf(handler.reset())).toEqual({ success: true });
  expect(reload).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), 'factory');
  for (const name of ['app', 'pane', 'agent'] as const) {
    // Every type of browsing data is being cleared, the network history among them.
    expect(owned(name).clearData).toHaveBeenCalledExactlyOnceWith();
    expect(owned(name).clearStorageData).toHaveBeenCalledOnce();
    expect(owned(name).clearCache).toHaveBeenCalledOnce();
  }
});

it('fails the reset, and keeps the old window, when a clear a page could read fails', async () => {
  for (const name of ['app', 'pane', 'agent'] as const) {
    owned(name).networkHistoryWrite.resolve();
  }
  owned('pane').clearStorageData.mockRejectedValueOnce(new Error('pane storage is locked'));
  const { handler, reload } = await factoryReset();

  await expect(handler.reset()).resolves.toEqual({
    message: 'Failed to clear desktop browser sessions',
    success: false,
  });
  expect(reload).not.toHaveBeenCalled();
});

it('tells the person when Chromium fails to clear the browsing data after the window started', async () => {
  const error = vi.spyOn(createLogger('BrowserSession'), 'error');
  const { handler, published } = await factoryReset(async () => {
    render(<ReplacementWindow />);
  });
  expect(await answerOf(handler.reset())).toEqual({ success: true });

  const failure = new Error('network history could not be written');
  owned('pane').networkHistoryWrite.reject(failure);

  expect(await screen.findByText(NOT_CLEARED)).toBeVisible();
  expect(
    screen.getByText(
      "network history could not be written Some sites' HTTPS-only settings (HSTS) and connection hints may remain. Run Factory Reset again to clear them."
    )
  ).toBeVisible();
  expect(published).toEqual([
    {
      browsingData: { reason: 'network history could not be written', status: 'failed' },
      mode: 'factory',
    },
  ]);
  expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('network history'), {
    error: failure,
    session: 'persist:browser-pane',
  });
});

it('tells the window that starts after Chromium failed, through the outcome it takes', async () => {
  const { handler, published } = await factoryReset(async () => {
    owned('app').networkHistoryWrite.reject(new Error('the disk is full'));
    await queuedWork();
    render(<ReplacementWindow />);
  });

  await expect(handler.reset()).resolves.toEqual({ success: true });

  expect(await screen.findByText(NOT_CLEARED)).toBeVisible();
  expect(screen.getAllByText(NOT_CLEARED)).toHaveLength(1);
  expect(published).toEqual([]);
});
