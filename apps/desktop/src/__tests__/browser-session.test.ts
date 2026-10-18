import { beforeEach, expect, it, vi } from 'vitest';

type HeadersListener = (
  details: {
    readonly resourceType: string;
    readonly responseHeaders?: Record<string, string[]>;
    readonly url: string;
    readonly webContentsId?: number;
  },
  callback: (response: { cancel?: boolean }) => void
) => void;

const fixture = vi.hoisted(() => {
  const makeSession = () => {
    const state: { headersListener: HeadersListener | null } = { headersListener: null };
    return {
      clearAuthCache: vi.fn(async () => undefined),
      clearData: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
      on: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setProxy: vi.fn(async (_config: { proxyRules?: string }) => undefined),
      state,
      webRequest: {
        onHeadersReceived: vi.fn((listener: HeadersListener) => {
          state.headersListener = listener;
        }),
      },
    };
  };
  return { agent: makeSession(), app: makeSession(), pane: makeSession() };
});
vi.mock('electron', () => ({
  session: {
    defaultSession: fixture.app,
    fromPartition: (partition: string) =>
      partition === 'browser-pane-agent' ? fixture.agent : fixture.pane,
  },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.agent.state.headersListener = null;
  const { __resetBrowserPaneSessionForTests } = await import('../browser/browser-session');
  __resetBrowserPaneSessionForTests();
});

it('clears the app, pane and agent sessions through Electron without origin exclusions', async () => {
  const { clearDesktopBrowserSessions } = await import('../browser/browser-session');
  await clearDesktopBrowserSessions();
  for (const owned of [fixture.app, fixture.pane, fixture.agent]) {
    expect(owned.clearData).toHaveBeenCalledExactlyOnceWith();
    expect(owned.clearAuthCache).toHaveBeenCalledExactlyOnceWith();
    expect(owned.closeAllConnections).toHaveBeenCalledExactlyOnceWith();
  }
});

it.each(['app', 'pane', 'agent'] as const)(
  'keeps the %s session clearing failure visible and attempts the other sessions',
  async (name) => {
    const failure = new Error(`${name} browser data could not be cleared`);
    fixture[name].clearData.mockRejectedValueOnce(failure);
    const { clearDesktopBrowserSessions } = await import('../browser/browser-session');
    await expect(clearDesktopBrowserSessions()).rejects.toMatchObject({ errors: [failure] });
    expect(fixture.app.clearData).toHaveBeenCalledOnce();
    expect(fixture.pane.clearData).toHaveBeenCalledOnce();
    expect(fixture.agent.clearData).toHaveBeenCalledOnce();
  }
);

it('routes the agent partition only through its egress proxy, loopback included (BST-1238)', async () => {
  const { routeAgentBrowserSession } = await import('../browser/browser-session');
  await routeAgentBrowserSession(41_000, vi.fn());
  expect(fixture.agent.setProxy).toHaveBeenCalledExactlyOnceWith({
    mode: 'fixed_servers',
    proxyBypassRules: '<-loopback>',
    proxyRules: '127.0.0.1:41000',
  });
  expect(fixture.agent.closeAllConnections).toHaveBeenCalledOnce();
  // Hardened like the user's pane partition: no permissions, no downloads.
  expect(fixture.agent.setPermissionRequestHandler).toHaveBeenCalledOnce();
  expect(fixture.agent.setPermissionCheckHandler).toHaveBeenCalledOnce();
  expect(fixture.agent.on).toHaveBeenCalledWith('will-download', expect.any(Function));
  expect(fixture.pane.setProxy).not.toHaveBeenCalled();
});

it('re-routes only when the proxy port changes, and hardens once', async () => {
  const { routeAgentBrowserSession } = await import('../browser/browser-session');
  await routeAgentBrowserSession(41_000, vi.fn());
  await routeAgentBrowserSession(41_000, vi.fn());
  await routeAgentBrowserSession(42_000, vi.fn());
  expect(fixture.agent.setProxy.mock.calls.map(([config]) => config.proxyRules)).toEqual([
    '127.0.0.1:41000',
    '127.0.0.1:42000',
  ]);
  expect(fixture.agent.closeAllConnections).toHaveBeenCalledTimes(2);
  expect(fixture.agent.setPermissionRequestHandler).toHaveBeenCalledOnce();
  expect(fixture.agent.webRequest.onHeadersReceived).toHaveBeenCalledOnce();
});

it('cancels a response the proxy refused and names its tab, so the load fails visibly', async () => {
  const onRefused = vi.fn();
  const { routeAgentBrowserSession } = await import('../browser/browser-session');
  await routeAgentBrowserSession(41_000, onRefused);
  const listener = fixture.agent.state.headersListener;
  if (listener === null) {
    throw new Error('No response listener was installed');
  }
  const refused = vi.fn();
  listener(
    {
      resourceType: 'mainFrame',
      responseHeaders: { 'X-Brainstrike-Egress-Refusal': ['loopback'] },
      url: 'http://internal.test/admin',
      webContentsId: 9,
    },
    refused
  );
  expect(refused).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  expect(onRefused).toHaveBeenCalledExactlyOnceWith({
    isMainFrame: true,
    refusal: 'loopback',
    url: 'http://internal.test/admin',
    webContentsId: 9,
  });
  const passed = vi.fn();
  listener(
    {
      resourceType: 'mainFrame',
      responseHeaders: { 'content-type': ['text/html'] },
      url: 'http://public.test/',
      webContentsId: 9,
    },
    passed
  );
  expect(passed).toHaveBeenCalledExactlyOnceWith({});
  expect(onRefused).toHaveBeenCalledOnce();
});
