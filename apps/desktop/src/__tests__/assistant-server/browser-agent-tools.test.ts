import { describe, expect, it, vi } from 'vitest';
import {
  getCachedSnapshotRefs,
  runBrowserGetPageText,
  runBrowserNavigate,
  runBrowserReadPage,
} from '../../assistant-server/browser-agent-tools';
import type { BrowserTabState } from '../../browser/browser-view-manager';

function tab(overrides: Partial<BrowserTabState>): BrowserTabState {
  return {
    active: true,
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    owner: 'agent',
    tabId: 'tab-1',
    title: 'T',
    url: 'https://x/',
    ...overrides,
  };
}

/** A fake pane host: scripted tab states per listTabs() call + a fake driver. */
function fakeHost(options?: {
  tabsSequence?: BrowserTabState[][];
  snapshot?: { refs: Record<string, number>; text: string; truncated: boolean };
  pageText?: { text: string; truncated: boolean };
}) {
  const sequence = options?.tabsSequence ?? [[tab({})]];
  let call = 0;
  const manager = {
    createTab: vi.fn(() => 'tab-1'),
    getActiveWebContentsId: vi.fn(() => 7),
    getNavigationError: vi.fn((): string | null => null),
    getWebContentsId: vi.fn((): number | null => 7),
    listTabs: vi.fn(() => sequence[Math.min(call++, sequence.length - 1)] ?? []),
    navigate: vi.fn(() => true),
    selectTab: vi.fn(() => true),
  };
  const driver = {
    getPageText: vi.fn(() =>
      Promise.resolve(options?.pageText ?? { text: 'body', truncated: false })
    ),
    screenshot: vi.fn(),
    snapshot: vi.fn(() =>
      Promise.resolve(
        options?.snapshot ?? { refs: { e1: 42 }, text: 'button "Go" [ref=e1]', truncated: false }
      )
    ),
  };
  const prepareAgentBrowsing = vi.fn(() => Promise.resolve());
  return { driver, manager, prepareAgentBrowsing };
}

describe('runBrowserNavigate', () => {
  it('navigates the active tab and returns the settled url/title', async () => {
    const host = fakeHost({
      tabsSequence: [
        [tab({})], // pre-navigate: a tab exists
        [tab({ isLoading: true, url: 'https://example.com/' })],
        [tab({ isLoading: false, title: 'Example Domain', url: 'https://example.com/' })],
      ],
    });
    const result = await runBrowserNavigate({ url: 'example.com' }, host, { pollMs: 1 });
    // The manager receives the NORMALIZED url — exactly what the guard vetted.
    expect(host.manager.navigate).toHaveBeenCalledWith('tab-1', 'https://example.com');
    expect(result).toEqual({
      ok: true,
      title: 'Example Domain',
      url: 'https://example.com/',
    });
  });

  it('creates a tab when none is open', async () => {
    const host = fakeHost({
      tabsSequence: [
        [], // no tabs yet
        [tab({ title: 'Example Domain', url: 'https://example.com/' })],
      ],
    });
    const result = await runBrowserNavigate({ url: 'https://example.com' }, host, { pollMs: 1 });
    expect(host.manager.createTab).toHaveBeenCalledWith('https://example.com', 'agent');
    expect(result).toMatchObject({ ok: true, url: 'https://example.com/' });
  });

  it('never drives a tab the user opened: it opens its own agent tab (BST-1238)', async () => {
    const userTab = tab({ owner: 'user', tabId: 'user-1', url: 'http://localhost:3000/' });
    const host = fakeHost({
      tabsSequence: [
        [userTab],
        [{ ...userTab, active: false }, tab({ isLoading: true, url: 'https://example.com/' })],
        [{ ...userTab, active: false }, tab({ title: 'Example', url: 'https://example.com/' })],
      ],
    });
    const result = await runBrowserNavigate({ url: 'https://example.com' }, host, { pollMs: 1 });
    expect(host.manager.navigate).not.toHaveBeenCalled();
    expect(host.manager.createTab).toHaveBeenCalledWith('https://example.com', 'agent');
    expect(result).toEqual({ ok: true, title: 'Example', url: 'https://example.com/' });
  });

  it('reuses its latest agent tab, selecting it over the active user tab', async () => {
    const userTab = tab({ owner: 'user', tabId: 'user-1', url: 'https://docs.test/' });
    const agentTab = tab({ active: false, tabId: 'agent-1', url: 'https://before.test/' });
    const host = fakeHost({
      tabsSequence: [
        [userTab, agentTab],
        [
          { ...userTab, active: false },
          { ...agentTab, active: true, isLoading: true },
        ],
        [
          { ...userTab, active: false },
          { ...agentTab, active: true, title: 'After', url: 'https://after.test/' },
        ],
      ],
    });
    const result = await runBrowserNavigate({ url: 'https://after.test' }, host, { pollMs: 1 });
    expect(host.manager.selectTab).toHaveBeenCalledWith('agent-1');
    expect(host.manager.navigate).toHaveBeenCalledWith('agent-1', 'https://after.test');
    expect(host.manager.createTab).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, title: 'After', url: 'https://after.test/' });
  });

  it('routes agent browsing through its proxy before opening or loading any tab', async () => {
    const order: string[] = [];
    const host = fakeHost({ tabsSequence: [[], [tab({ title: 'E', url: 'https://e.test/' })]] });
    host.prepareAgentBrowsing.mockImplementation(() => {
      order.push('prepare');
      return Promise.resolve();
    });
    host.manager.createTab.mockImplementation(() => {
      order.push('createTab');
      return 'tab-1';
    });
    await runBrowserNavigate({ url: 'https://e.test' }, host, { pollMs: 1 });
    expect(order).toEqual(['prepare', 'createTab']);
    // A public page admits no loopback server.
    expect(host.prepareAgentBrowsing).toHaveBeenCalledWith();
  });

  it('opens an approved loopback dev server, admitting it for its own tab only (BST-1178)', async () => {
    const order: string[] = [];
    const host = fakeHost({
      tabsSequence: [[], [tab({ title: 'Dev', url: 'http://localhost:5173/' })]],
    });
    host.manager.createTab.mockImplementation(((url: string) => {
      order.push(`createTab ${url}`);
      return 'tab-1';
    }) as never);
    host.prepareAgentBrowsing.mockImplementation((() => {
      order.push('prepare');
      return Promise.resolve();
    }) as never);
    host.manager.navigate.mockImplementation(((_tabId: string, url: string) => {
      order.push(`navigate ${url}`);
      return true;
    }) as never);
    const result = await runBrowserNavigate({ url: 'http://localhost:5173/' }, host, { pollMs: 1 });
    // The tab opens blank (no network), its admission names it, then it loads.
    expect(order).toEqual(['createTab about:blank', 'prepare', 'navigate http://localhost:5173/']);
    expect(host.prepareAgentBrowsing).toHaveBeenCalledExactlyOnceWith({
      authority: 'localhost:5173',
      origin: 'http://localhost:5173',
      webContentsId: 7,
    });
    expect(result).toEqual({ ok: true, title: 'Dev', url: 'http://localhost:5173/' });
  });

  it('runs one agent navigation at a time, so a parallel call never replaces an admission mid-load', async () => {
    const host = fakeHost({
      tabsSequence: [[tab({ isLoading: true })], [tab({})], [tab({})], [tab({})]],
    });
    const events: string[] = [];
    host.prepareAgentBrowsing.mockImplementation(((admission?: { authority: string }) => {
      events.push(`prepare ${admission?.authority ?? 'public'}`);
      return Promise.resolve();
    }) as never);
    const first = runBrowserNavigate({ url: 'http://localhost:5173/' }, host, { pollMs: 1 }).then(
      (result) => {
        events.push('first settled');
        return result;
      }
    );
    const second = runBrowserNavigate({ url: 'https://example.com/' }, host, { pollMs: 1 });
    await Promise.all([first, second]);
    expect(events).toEqual(['prepare localhost:5173', 'first settled', 'prepare public']);
  });

  it('fails visibly, opening nothing, when the egress route cannot start', async () => {
    const host = fakeHost();
    host.prepareAgentBrowsing.mockRejectedValueOnce(new Error('proxy exited before it was ready'));
    const result = await runBrowserNavigate({ url: 'https://e.test' }, host, { pollMs: 1 });
    expect(result).toMatchObject({
      error: 'browser_unavailable',
      hint: expect.stringContaining('proxy exited before it was ready'),
      ok: false,
    });
    expect(host.manager.createTab).not.toHaveBeenCalled();
    expect(host.manager.navigate).not.toHaveBeenCalled();
  });

  it('surfaces a destination the egress proxy refused as blocked_destination', async () => {
    const host = fakeHost({
      tabsSequence: [[tab({})], [tab({ isLoading: true })], [tab({ title: '', url: '' })]],
    });
    host.manager.getNavigationError.mockReturnValue(
      'blocked_destination: agent browsing may not connect to internal.test, a loopback address'
    );
    const result = await runBrowserNavigate({ url: 'https://redirects.example' }, host, {
      pollMs: 1,
    });
    expect(result).toEqual({
      error: 'blocked_destination',
      hint: 'agent browsing may not connect to internal.test, a loopback address',
      ok: false,
    });
  });

  it('returns a structured timeout when the load never settles (no silent hang)', async () => {
    const host = fakeHost({
      tabsSequence: [[tab({})], [tab({ isLoading: true })]],
    });
    const result = await runBrowserNavigate({ url: 'https://slow.example' }, host, {
      pollMs: 1,
      timeoutMs: 10,
    });
    expect(result).toMatchObject({ error: 'load_timeout', ok: false });
  });

  it('returns a structured failure when no pane host exists', async () => {
    const result = await runBrowserNavigate({ url: 'https://x' }, null, { pollMs: 1 });
    expect(result).toMatchObject({ error: 'browser_unavailable', ok: false });
  });

  it('refuses non-http(s), private/loopback hosts, and credential URLs (webExtract guard)', async () => {
    const host = fakeHost();
    for (const url of [
      'file:///etc/passwd',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/admin',
      'http://127.0.0.2:3000',
      'http://app.localhost:3000',
      'http://user:pass@localhost:3000',
      'https://user:pass@example.com/',
      'about:blank',
    ]) {
      const result = await runBrowserNavigate({ url }, host, { pollMs: 1 });
      expect(result, url).toMatchObject({ error: 'blocked_url', ok: false });
    }
    expect(host.manager.navigate).not.toHaveBeenCalled();
    expect(host.manager.createTab).not.toHaveBeenCalled();
  });

  it('surfaces a failed load as load_failed, never an ok blank page', async () => {
    const host = fakeHost({
      tabsSequence: [
        [tab({})],
        [tab({ isLoading: true })],
        [tab({ title: '', url: 'about:blank' })],
      ],
    });
    host.manager.getNavigationError.mockReturnValue(
      'Error: ERR_NAME_NOT_RESOLVED (-105) loading https://nope.invalid/'
    );
    const result = await runBrowserNavigate({ url: 'https://nope.invalid' }, host, { pollMs: 1 });
    expect(result).toMatchObject({
      error: 'load_failed',
      hint: expect.stringContaining('ERR_NAME_NOT_RESOLVED'),
      ok: false,
    });
  });

  it('reports the NAVIGATED tab, not whatever tab became active mid-wait', async () => {
    // The user switches to tab-2 while the agent's navigation loads in tab-1.
    const tab2 = tab({ active: true, tabId: 'tab-2', title: 'Other', url: 'https://other/' });
    const host = fakeHost({
      tabsSequence: [
        [tab({})],
        [tab({ active: false, isLoading: true }), tab2],
        [tab({ active: false, title: 'Example Domain', url: 'https://example.com/' }), tab2],
      ],
    });
    const result = await runBrowserNavigate({ url: 'https://example.com' }, host, { pollMs: 1 });
    expect(result).toEqual({ ok: true, title: 'Example Domain', url: 'https://example.com/' });
  });
});

describe('runBrowserReadPage', () => {
  it('returns the tree text and caches the refs per webContents for later act-by-ref', async () => {
    const host = fakeHost({
      snapshot: { refs: { e1: 42, e2: 43 }, text: 'tree', truncated: false },
    });
    const result = await runBrowserReadPage({ filter: 'interactive', maxChars: 1000 }, host);
    expect(result).toEqual({ ok: true, tree: 'tree', truncated: false });
    // Refs never go to the model (token cost, and eN handles are already in
    // the text) — they are cached for PR3's click/type-by-ref.
    expect(getCachedSnapshotRefs(7)).toEqual({ e1: 42, e2: 43 });
  });

  it('keys the ref cache by the id captured BEFORE the snapshot await (mid-await tab switch)', async () => {
    const host = fakeHost({ snapshot: { refs: { e1: 99 }, text: 'tree', truncated: false } });
    // The driver targets the tab that was active at call time (id 21); the
    // user switches tabs during the await (id 22 becomes active).
    host.manager.getActiveWebContentsId.mockReturnValueOnce(21).mockReturnValue(22);
    await runBrowserReadPage({ filter: 'all', maxChars: 1000 }, host);
    expect(getCachedSnapshotRefs(21)).toEqual({ e1: 99 });
    expect(getCachedSnapshotRefs(22)).toBeUndefined();
  });

  it('surfaces a driver failure as a structured error (never a throw)', async () => {
    const host = fakeHost();
    host.driver.snapshot.mockRejectedValueOnce(new Error('No active browser tab to drive'));
    const result = await runBrowserReadPage({ filter: 'all', maxChars: 1000 }, host);
    expect(result).toMatchObject({ error: 'driver_failed', ok: false });
  });
});

describe('runBrowserGetPageText', () => {
  it('returns the page text', async () => {
    const host = fakeHost({ pageText: { text: 'hello', truncated: true } });
    const result = await runBrowserGetPageText({ maxChars: 5 }, host);
    expect(host.driver.getPageText).toHaveBeenCalledWith(5);
    expect(result).toEqual({ ok: true, text: 'hello', truncated: true });
  });

  it('returns browser_unavailable without a host', async () => {
    const result = await runBrowserGetPageText({ maxChars: 100 }, null);
    expect(result).toMatchObject({ error: 'browser_unavailable', ok: false });
  });
});
