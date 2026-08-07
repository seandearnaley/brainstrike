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
    expect(host.manager.navigate).toHaveBeenCalledWith('tab-1', 'example.com');
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
