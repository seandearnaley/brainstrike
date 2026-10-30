import { describe, expect, it, vi } from 'vitest';
import {
  getCachedSnapshotRefs,
  runBrowserClick,
  runBrowserGetPageText,
  runBrowserNavigate,
  runBrowserReadPage,
  runBrowserSelectOption,
  runBrowserType,
} from '../../assistant-server/browser-agent-tools';
import type { ActionTargetFacts } from '../../browser/browser-action-guard';
import { BrowserActionError } from '../../browser/browser-driver';
import type { BrowserTabOwner, BrowserTabState } from '../../browser/browser-view-manager';

const THREAD = 'thread-1';

const plainButton: ActionTargetFacts = {
  autocomplete: [],
  captcha: false,
  connected: true,
  disabled: false,
  form: null,
  hints: '',
  submits: false,
  tag: 'button',
  text: 'Go',
  type: '',
};

function tab(overrides: Partial<BrowserTabState>): BrowserTabState {
  return {
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    owner: 'agent',
    tabId: 'tab-1',
    threadId: THREAD,
    title: 'T',
    url: 'https://x/',
    ...overrides,
  };
}

/**
 * A fake pane host: scripted tab states per listTabs() call + a fake driver.
 * A thread's current page is its last listed one, read from the state the
 * next listTabs() call returns.
 */
function fakeHost(options?: {
  tabsSequence?: BrowserTabState[][];
  snapshot?: { refs: Record<string, number>; text: string; truncated: boolean };
  pageText?: { text: string; truncated: boolean };
  facts?: ActionTargetFacts;
}) {
  const sequence = options?.tabsSequence ?? [[tab({})]];
  let call = 0;
  const current = (): BrowserTabState[] => sequence[Math.min(call, sequence.length - 1)] ?? [];
  const manager = {
    createTab: vi.fn((_threadId: string, _url?: string, _owner?: BrowserTabOwner) => 'tab-1'),
    currentTab: vi.fn(
      (threadId: string, owner?: BrowserTabOwner): string | null =>
        current()
          .filter((page) => page.threadId === threadId && (owner ?? page.owner) === page.owner)
          .at(-1)?.tabId ?? null
    ),
    getNavigationError: vi.fn((): string | null => null),
    getWebContentsId: vi.fn((): number | null => 7),
    listTabs: vi.fn(() => {
      const tabs = current();
      call += 1;
      return tabs;
    }),
    navigate: vi.fn((_tabId: string, _url: string) => true),
  };
  const driver = {
    click: vi.fn((_node: number) => Promise.resolve()),
    documentId: vi.fn(() => Promise.resolve('doc-1')),
    getPageText: vi.fn(() =>
      Promise.resolve(options?.pageText ?? { text: 'body', truncated: false })
    ),
    screenshot: vi.fn(),
    selectOptions: vi.fn((_node: number, values: readonly string[]) => Promise.resolve(values)),
    snapshot: vi.fn(() =>
      Promise.resolve(
        options?.snapshot ?? { refs: { e1: 42 }, text: 'button "Go" [ref=e1]', truncated: false }
      )
    ),
    targetFacts: vi.fn((_node: number) => Promise.resolve(options?.facts ?? plainButton)),
    type: vi.fn((_node: number, _text: string, _submit: boolean) => Promise.resolve()),
  };
  const prepareAgentBrowsing = vi.fn((_loopback?: unknown) => Promise.resolve());
  return { driver, driverFor: vi.fn((_tabId: string) => driver), manager, prepareAgentBrowsing };
}

describe('runBrowserNavigate', () => {
  it("navigates the conversation's agent page and returns the settled url/title", async () => {
    const host = fakeHost({
      tabsSequence: [
        [tab({})], // pre-navigate: a tab exists
        [tab({ isLoading: true, url: 'https://example.com/' })],
        [tab({ isLoading: false, title: 'Example Domain', url: 'https://example.com/' })],
      ],
    });
    const result = await runBrowserNavigate({ url: 'example.com' }, THREAD, host, { pollMs: 1 });
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
    const result = await runBrowserNavigate({ url: 'https://example.com' }, THREAD, host, {
      pollMs: 1,
    });
    expect(host.manager.createTab).toHaveBeenCalledWith(THREAD, 'https://example.com', 'agent');
    expect(result).toMatchObject({ ok: true, url: 'https://example.com/' });
  });

  it('never drives a tab the user opened: it opens its own agent tab (BST-1238)', async () => {
    const userTab = tab({ owner: 'user', tabId: 'user-1', url: 'http://localhost:3000/' });
    const host = fakeHost({
      tabsSequence: [
        [userTab],
        [userTab, tab({ isLoading: true, url: 'https://example.com/' })],
        [userTab, tab({ title: 'Example', url: 'https://example.com/' })],
      ],
    });
    const result = await runBrowserNavigate({ url: 'https://example.com' }, THREAD, host, {
      pollMs: 1,
    });
    expect(host.manager.navigate).not.toHaveBeenCalled();
    expect(host.manager.createTab).toHaveBeenCalledWith(THREAD, 'https://example.com', 'agent');
    expect(result).toEqual({ ok: true, title: 'Example', url: 'https://example.com/' });
  });

  it("never drives another conversation's agent page (BST-1271)", async () => {
    const elsewhere = tab({ tabId: 'other-1', threadId: 'thread-2', url: 'https://other.test/' });
    const host = fakeHost({
      tabsSequence: [[elsewhere], [elsewhere, tab({ title: 'Mine', url: 'https://mine.test/' })]],
    });
    const result = await runBrowserNavigate({ url: 'https://mine.test' }, THREAD, host, {
      pollMs: 1,
    });
    expect(host.manager.navigate).not.toHaveBeenCalled();
    expect(host.manager.createTab).toHaveBeenCalledWith(THREAD, 'https://mine.test', 'agent');
    expect(result).toEqual({ ok: true, title: 'Mine', url: 'https://mine.test/' });
  });

  it("reuses its latest agent page in the conversation, beside the person's page", async () => {
    const userTab = tab({ owner: 'user', tabId: 'user-1', url: 'https://docs.test/' });
    const agentTab = tab({ tabId: 'agent-1', url: 'https://before.test/' });
    const host = fakeHost({
      tabsSequence: [
        [agentTab, userTab],
        [{ ...agentTab, isLoading: true }, userTab],
        [{ ...agentTab, title: 'After', url: 'https://after.test/' }, userTab],
      ],
    });
    const result = await runBrowserNavigate({ url: 'https://after.test' }, THREAD, host, {
      pollMs: 1,
    });
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
    await runBrowserNavigate({ url: 'https://e.test' }, THREAD, host, { pollMs: 1 });
    expect(order).toEqual(['prepare', 'createTab']);
    // A public page admits no loopback server.
    expect(host.prepareAgentBrowsing).toHaveBeenCalledWith();
  });

  it('opens an approved loopback dev server, admitting it for its own tab only (BST-1178)', async () => {
    const order: string[] = [];
    const host = fakeHost({
      tabsSequence: [[], [tab({ title: 'Dev', url: 'http://localhost:5173/' })]],
    });
    host.manager.createTab.mockImplementation((_threadId, url) => {
      order.push(`createTab ${url}`);
      return 'tab-1';
    });
    host.prepareAgentBrowsing.mockImplementation(() => {
      order.push('prepare');
      return Promise.resolve();
    });
    host.manager.navigate.mockImplementation((_tabId, url) => {
      order.push(`navigate ${url}`);
      return true;
    });
    const result = await runBrowserNavigate({ url: 'http://localhost:5173/' }, THREAD, host, {
      pollMs: 1,
    });
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
    host.prepareAgentBrowsing.mockImplementation((admission) => {
      const authority = (admission as { authority: string } | undefined)?.authority;
      events.push(`prepare ${authority ?? 'public'}`);
      return Promise.resolve();
    });
    const first = runBrowserNavigate({ url: 'http://localhost:5173/' }, THREAD, host, {
      pollMs: 1,
    }).then((result) => {
      events.push('first settled');
      return result;
    });
    const second = runBrowserNavigate({ url: 'https://example.com/' }, THREAD, host, { pollMs: 1 });
    await Promise.all([first, second]);
    expect(events).toEqual(['prepare localhost:5173', 'first settled', 'prepare public']);
  });

  it('fails visibly, opening nothing, when the egress route cannot start', async () => {
    const host = fakeHost();
    host.prepareAgentBrowsing.mockRejectedValueOnce(new Error('proxy exited before it was ready'));
    const result = await runBrowserNavigate({ url: 'https://e.test' }, THREAD, host, { pollMs: 1 });
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
    const result = await runBrowserNavigate({ url: 'https://redirects.example' }, THREAD, host, {
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
    const result = await runBrowserNavigate({ url: 'https://slow.example' }, THREAD, host, {
      pollMs: 1,
      timeoutMs: 10,
    });
    expect(result).toMatchObject({ error: 'load_timeout', ok: false });
  });

  it('returns a structured failure when no pane host exists', async () => {
    const result = await runBrowserNavigate({ url: 'https://x' }, THREAD, null, { pollMs: 1 });
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
      const result = await runBrowserNavigate({ url }, THREAD, host, { pollMs: 1 });
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
    const result = await runBrowserNavigate({ url: 'https://nope.invalid' }, THREAD, host, {
      pollMs: 1,
    });
    expect(result).toMatchObject({
      error: 'load_failed',
      hint: expect.stringContaining('ERR_NAME_NOT_RESOLVED'),
      ok: false,
    });
  });

  it('reports the NAVIGATED page, not whatever page the person opened mid-wait', async () => {
    // The person opens tab-2 while the agent's navigation loads in tab-1.
    const tab2 = tab({ owner: 'user', tabId: 'tab-2', title: 'Other', url: 'https://other/' });
    const host = fakeHost({
      tabsSequence: [
        [tab({})],
        [tab({ isLoading: true }), tab2],
        [tab({ title: 'Example Domain', url: 'https://example.com/' }), tab2],
      ],
    });
    const result = await runBrowserNavigate({ url: 'https://example.com' }, THREAD, host, {
      pollMs: 1,
    });
    expect(result).toEqual({ ok: true, title: 'Example Domain', url: 'https://example.com/' });
  });
});

describe('runBrowserReadPage', () => {
  it('returns the tree text and caches the refs per webContents for later act-by-ref', async () => {
    const host = fakeHost({
      snapshot: { refs: { e1: 42, e2: 43 }, text: 'tree', truncated: false },
    });
    const result = await runBrowserReadPage(
      { filter: 'interactive', maxChars: 1000 },
      THREAD,
      host
    );
    expect(result).toEqual({ ok: true, tree: 'tree', truncated: false });
    // Refs never go to the model (token cost, and eN handles are already in
    // the text) — they are cached for the acting tools (BST-2324).
    expect(getCachedSnapshotRefs(7)).toEqual({ e1: 42, e2: 43 });
  });

  it('keys the ref cache by the page id captured BEFORE the snapshot await (mid-await navigation)', async () => {
    const host = fakeHost({ snapshot: { refs: { e1: 99 }, text: 'tree', truncated: false } });
    // The page's webContents is 21 at call time; a later lookup would say 22.
    host.manager.getWebContentsId.mockReturnValueOnce(21).mockReturnValue(22);
    await runBrowserReadPage({ filter: 'all', maxChars: 1000 }, THREAD, host);
    expect(getCachedSnapshotRefs(21)).toEqual({ e1: 99 });
    expect(getCachedSnapshotRefs(22)).toBeUndefined();
  });

  it("reads the conversation's current page, whoever opened it", async () => {
    const host = fakeHost({
      tabsSequence: [
        [
          tab({ owner: 'user', tabId: 'user-1' }),
          tab({ owner: 'user', tabId: 'elsewhere', threadId: 'thread-2' }),
        ],
      ],
    });
    await runBrowserReadPage({ filter: 'all', maxChars: 1000 }, THREAD, host);
    expect(host.driverFor).toHaveBeenCalledExactlyOnceWith('user-1');
  });

  it('says so when the conversation has no page open', async () => {
    const host = fakeHost({ tabsSequence: [[tab({ threadId: 'thread-2' })]] });
    const result = await runBrowserReadPage({ filter: 'all', maxChars: 1000 }, THREAD, host);
    expect(result).toMatchObject({
      error: 'driver_failed',
      hint: expect.stringContaining('No browser page is open in this conversation'),
      ok: false,
    });
    expect(host.driverFor).not.toHaveBeenCalled();
  });

  it('surfaces a driver failure as a structured error (never a throw)', async () => {
    const host = fakeHost();
    host.driver.snapshot.mockRejectedValueOnce(new Error('Browser page tab-1 is no longer open'));
    const result = await runBrowserReadPage({ filter: 'all', maxChars: 1000 }, THREAD, host);
    expect(result).toMatchObject({ error: 'driver_failed', ok: false });
  });
});

describe('runBrowserGetPageText', () => {
  it('returns the page text', async () => {
    const host = fakeHost({ pageText: { text: 'hello', truncated: true } });
    const result = await runBrowserGetPageText({ maxChars: 5 }, THREAD, host);
    expect(host.driver.getPageText).toHaveBeenCalledWith(5);
    expect(result).toEqual({ ok: true, text: 'hello', truncated: true });
  });

  it('returns browser_unavailable without a host', async () => {
    const result = await runBrowserGetPageText({ maxChars: 100 }, THREAD, null);
    expect(result).toMatchObject({ error: 'browser_unavailable', ok: false });
  });
});

describe('the acting tools (BST-2324)', () => {
  const FAST = { graceMs: 0, pollMs: 1 } as const;

  /** The agent opened https://x/ (a person approved it) and read the page. */
  async function readyHost(
    options: { facts?: ActionTargetFacts; landed?: BrowserTabState } = {}
  ): Promise<ReturnType<typeof fakeHost>> {
    const host = fakeHost({
      ...(options.facts ? { facts: options.facts } : {}),
      tabsSequence: [
        [tab({ url: 'about:blank' })],
        [tab({ isLoading: true, url: 'https://x/' })],
        [options.landed ?? tab({ title: 'X', url: 'https://x/' })],
      ],
    });
    await runBrowserNavigate({ url: 'https://x' }, THREAD, host, { pollMs: 1 });
    await runBrowserReadPage({ filter: 'interactive', maxChars: 1000 }, THREAD, host);
    return host;
  }

  it('clicks a ref from its last read and reports where the page is', async () => {
    const host = await readyHost();
    const result = await runBrowserClick({ element: 'Go button', ref: 'e1' }, THREAD, host, FAST);
    expect(host.driver.click).toHaveBeenCalledExactlyOnceWith(42);
    expect(result).toEqual({ ok: true, title: 'X', url: 'https://x/' });
  });

  it('fills a field and picks options', async () => {
    const host = await readyHost();
    await expect(
      runBrowserType(
        { element: 'Search', ref: 'e1', submit: true, text: 'shoes' },
        THREAD,
        host,
        FAST
      )
    ).resolves.toMatchObject({ ok: true });
    expect(host.driver.type).toHaveBeenCalledExactlyOnceWith(42, 'shoes', true);
    await expect(
      runBrowserSelectOption({ element: 'Size', ref: 'e1', values: ['L'] }, THREAD, host, FAST)
    ).resolves.toEqual({ ok: true, selected: ['L'], title: 'X', url: 'https://x/' });
  });

  it('never acts on a page the person opened', async () => {
    const host = fakeHost({ tabsSequence: [[tab({ owner: 'user' })]] });
    await runBrowserReadPage({ filter: 'interactive', maxChars: 1000 }, THREAD, host);
    const result = await runBrowserClick({ element: 'Go', ref: 'e1' }, THREAD, host, FAST);
    expect(result).toMatchObject({ error: 'not_agent_page', ok: false });
    expect(host.driver.click).not.toHaveBeenCalled();
  });

  it('refuses a page that moved to an origin it never opened (BST-2325)', async () => {
    const host = await readyHost({ landed: tab({ url: 'https://elsewhere.test/next' }) });
    const result = await runBrowserClick({ element: 'Go', ref: 'e1' }, THREAD, host, FAST);
    expect(result).toMatchObject({
      error: 'origin_not_approved',
      hint: expect.stringContaining('https://elsewhere.test'),
      ok: false,
    });
    expect(host.driver.click).not.toHaveBeenCalled();
  });

  it('refuses a ref once the page shows another document', async () => {
    const host = await readyHost();
    host.driver.documentId.mockResolvedValue('doc-2');
    const result = await runBrowserClick({ element: 'Go', ref: 'e1' }, THREAD, host, FAST);
    expect(result).toMatchObject({ error: 'stale_ref', ok: false });
    expect(host.driver.click).not.toHaveBeenCalled();
  });

  it('refuses a ref its last read did not have', async () => {
    const host = await readyHost();
    const result = await runBrowserClick({ element: 'Go', ref: 'e9' }, THREAD, host, FAST);
    expect(result).toMatchObject({ error: 'stale_ref', ok: false });
  });

  it('refuses a password field before anything is typed (BST-2209)', async () => {
    const host = await readyHost({ facts: { ...plainButton, tag: 'input', type: 'password' } });
    const result = await runBrowserType(
      { element: 'Password', ref: 'e1', submit: false, text: 'hunter2' },
      THREAD,
      host,
      FAST
    );
    expect(result).toMatchObject({
      error: 'blocked_action',
      hint: expect.stringContaining('credential'),
      ok: false,
    });
    expect(host.driver.type).not.toHaveBeenCalled();
  });

  it("reads the page's own refusal as a typed failure", async () => {
    const host = await readyHost();
    host.driver.click.mockRejectedValueOnce(
      new BrowserActionError('element_not_actionable', 'Another element covers it: <div>')
    );
    const result = await runBrowserClick({ element: 'Go', ref: 'e1' }, THREAD, host, FAST);
    expect(result).toMatchObject({
      error: 'element_not_actionable',
      hint: expect.stringContaining('Another element covers it'),
      ok: false,
    });
  });
});
