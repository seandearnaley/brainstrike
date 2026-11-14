/**
 * BST-2515 (ADR-0015): Factory Reset reloads once every clear a page or the reopened profile can
 * read has finished. Chromium's network history (HSTS, alt-svc) reaches disk on Chromium's own
 * schedule: its write runs at background priority, which a busy Mac can starve for minutes.
 */
import { createLogger } from '@brainstrike/logging';
import { beforeEach, expect, it, vi } from 'vitest';

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

/** Settles once every callback already queued has run: no time passes. */
const queuedWork = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function factoryReset() {
  const reload = vi.fn(async (_signal: AbortSignal, _mode: string) => undefined);
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
    resetLocalDatabase: async () => undefined,
    runtimes: [],
    sessionDataPath: '/mock/userData/session-data',
    userDataPath: '/mock/userData',
  });
  return { handler, reload };
}

it('reloads the window while Chromium still writes the cleared network history to disk', async () => {
  const { handler, reload } = await factoryReset();
  let answer: unknown = 'still waiting';
  void handler.reset().then((result) => {
    answer = result;
  });
  await queuedWork();

  expect(answer).toEqual({ success: true });
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

it('logs a network-history clear that fails after the reset, with its session', async () => {
  const error = vi.spyOn(createLogger('BrowserSession'), 'error');
  const { handler } = await factoryReset();
  let answer: unknown = 'still waiting';
  void handler.reset().then((result) => {
    answer = result;
  });
  await queuedWork();
  expect(answer).toEqual({ success: true });

  const failure = new Error('network history could not be written');
  owned('pane').networkHistoryWrite.reject(failure);
  await queuedWork();

  expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('network history'), {
    error: failure,
    session: 'persist:browser-pane',
  });
});
