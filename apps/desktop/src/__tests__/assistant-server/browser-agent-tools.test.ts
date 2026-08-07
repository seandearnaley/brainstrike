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
    listTabs: vi.fn(() => sequence[Math.min(call++, sequence.length - 1)] ?? []),
    navigate: vi.fn(() => true),
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
  return { driver, manager };
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
    expect(host.manager.createTab).toHaveBeenCalledWith('https://example.com');
    expect(result).toMatchObject({ ok: true, url: 'https://example.com/' });
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
      'http://localhost:3000',
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
