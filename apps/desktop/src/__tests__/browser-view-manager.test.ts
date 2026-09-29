import { describe, expect, it, vi } from 'vitest';
import {
  type BrowserPaneView,
  type BrowserTabState,
  BrowserViewManager,
  isNavigableUrl,
  normalizeUrl,
  type PaneRect,
} from '../browser/browser-view-manager';

interface FakeView extends BrowserPaneView {
  readonly calls: {
    bounds: PaneRect[];
    visible: boolean[];
    loaded: string[];
    closed: boolean;
  };
  emit(event: string): void;
  readonly listeners: Map<string, Array<(...args: unknown[]) => void>>;
  navState: { back: boolean; forward: boolean; title: string; url: string };
}

function createFakeView(id: number): FakeView {
  const calls = {
    bounds: [] as PaneRect[],
    closed: false,
    loaded: [] as string[],
    visible: [] as boolean[],
  };
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const navState = { back: false, forward: false, title: '', url: 'about:blank' };
  let openHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null = null;
  return {
    get __openHandler() {
      return openHandler;
    },
    calls,
    emit(event) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
    listeners,
    navState,
    setBounds: (rect) => calls.bounds.push(rect),
    setVisible: (visible) => calls.visible.push(visible),
    webContents: {
      canGoBack: () => navState.back,
      canGoForward: () => navState.forward,
      close: () => {
        calls.closed = true;
      },
      getTitle: () => navState.title,
      getURL: () => navState.url,
      goBack: vi.fn(),
      goForward: vi.fn(),
      id,
      isLoading: () => false,
      loadURL: (url) => {
        calls.loaded.push(url);
        navState.url = url;
        return Promise.resolve();
      },
      on: (event, listener) => {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
      reload: vi.fn(),
      setWindowOpenHandler: (handler) => {
        openHandler = handler;
      },
    },
  } as FakeView & { __openHandler: typeof openHandler };
}

function setup() {
  const created: FakeView[] = [];
  const added: BrowserPaneView[] = [];
  const removed: BrowserPaneView[] = [];
  let counter = 0;
  const onTabsChanged = vi.fn<(tabs: readonly BrowserTabState[]) => void>();
  const manager = new BrowserViewManager({
    createView: () => {
      const view = createFakeView(created.length + 1);
      created.push(view);
      return view;
    },
    hostWindow: {
      contentView: {
        addChildView: (view) => added.push(view),
        removeChildView: (view) => removed.push(view),
      },
      isDestroyed: () => false,
    },
    mintTabId: () => `tab-${++counter}`,
    onTabsChanged,
    partition: 'persist:browser-pane-test',
  });
  // A view is only shown at a non-zero rect, so most visibility assertions need
  // bounds already reported. Seed a default; tests that care set their own.
  manager.setBounds({ height: 300, width: 400, x: 0, y: 0 });
  return { added, created, manager, onTabsChanged, removed };
}

describe('normalizeUrl', () => {
  it('defaults blank to about:blank and preserves http/https/about/data', () => {
    expect(normalizeUrl(undefined)).toBe('about:blank');
    expect(normalizeUrl('  ')).toBe('about:blank');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://x.test/a?b=c')).toBe('http://x.test/a?b=c');
    expect(normalizeUrl('data:text/html,<p>hi</p>')).toBe('data:text/html,<p>hi</p>');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });

  it('adds https to bare hosts, incl. host:port and localhost', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeUrl('sub.example.co.uk/path')).toBe('https://sub.example.co.uk/path');
  });

  it('treats scheme-less, host-less input as a search query (not a broken URL)', () => {
    expect(normalizeUrl('what is rust')).toBe('https://duckduckgo.com/?q=what%20is%20rust');
    // A ":// substring" in a search phrase must NOT be mistaken for a scheme.
    expect(normalizeUrl('what does :// mean')).toBe(
      'https://duckduckgo.com/?q=what%20does%20%3A%2F%2F%20mean'
    );
  });

  it('does NOT preserve dangerous schemes as URLs — they become searches', () => {
    // normalizeUrl no longer whitelists file/devtools/chrome; isNavigableUrl is
    // the final gate, but even here they are not treated as navigable URLs.
    expect(isNavigableUrl('file:///etc/passwd')).toBe(false);
    expect(isNavigableUrl('devtools://devtools/bundled/devtools_app.html')).toBe(false);
    expect(isNavigableUrl('chrome://settings')).toBe(false);
    expect(isNavigableUrl('blob:https://x/uuid')).toBe(false);
    expect(isNavigableUrl('https://ok.test')).toBe(true);
    expect(isNavigableUrl('about:blank')).toBe(true);
  });
});

/**
 * A host window that BEHAVES LIKE ELECTRON once destroyed (BST-1843): the
 * `contentView` getter throws `Object has been destroyed` (as every property
 * of a destroyed `BrowserWindow` does) while `isDestroyed()` stays callable.
 */
function createElectronLikeHostWindow() {
  let destroyed = false;
  const attached: BrowserPaneView[] = [];
  const contentView = {
    addChildView: (view: BrowserPaneView) => attached.push(view),
    removeChildView: (view: BrowserPaneView) => {
      const index = attached.indexOf(view);
      if (index !== -1) {
        attached.splice(index, 1);
      }
    },
  };
  return {
    attached,
    destroy: () => {
      destroyed = true;
    },
    hostWindow: {
      get contentView() {
        if (destroyed) {
          throw new TypeError('Object has been destroyed');
        }
        return contentView;
      },
      isDestroyed: () => destroyed,
    },
  };
}

describe('BrowserViewManager.dispose — host window lifecycle (BST-1843)', () => {
  function setupWithElectronLikeWindow() {
    const created: FakeView[] = [];
    const host = createElectronLikeHostWindow();
    const onTabsChanged = vi.fn<(tabs: readonly BrowserTabState[]) => void>();
    let counter = 0;
    const manager = new BrowserViewManager({
      createView: () => {
        const view = createFakeView(created.length + 1);
        created.push(view);
        return view;
      },
      hostWindow: host.hostWindow,
      mintTabId: () => `tab-${++counter}`,
      onTabsChanged,
      partition: 'persist:browser-pane-test',
    });
    return { created, host, manager, onTabsChanged };
  }

  it('live window (renderer reload / factory reset): detaches every view AND releases its page', () => {
    const { created, host, manager, onTabsChanged } = setupWithElectronLikeWindow();
    manager.createTab('a.com');
    manager.createTab('b.com');
    expect(host.attached).toHaveLength(2);

    manager.dispose();

    expect(host.attached).toHaveLength(0);
    expect(created.map((view) => view.calls.closed)).toEqual([true, true]);
    expect(manager.listTabs()).toEqual([]);
    // The fresh renderer is told the pane is now empty.
    expect(onTabsChanged).toHaveBeenLastCalledWith([]);
  });

  it('destroyed window (win "closed"): does not touch the dead contentView, still releases every page', () => {
    const { created, host, manager, onTabsChanged } = setupWithElectronLikeWindow();
    manager.createTab('a.com');
    manager.createTab('b.com');
    host.destroy();

    // `closed` fires AFTER the BrowserWindow is destroyed; Electron does NOT
    // destroy a WebContentsView's webContents with its window, so they must
    // still be closed here or they leak.
    expect(() => manager.dispose()).not.toThrow();

    expect(created.map((view) => view.calls.closed)).toEqual([true, true]);
    expect(manager.listTabs()).toEqual([]);
    expect(manager.getActiveWebContentsId()).toBeNull();
    expect(onTabsChanged).toHaveBeenLastCalledWith([]);
  });
});

describe('BrowserViewManager', () => {
  it('creates a tab: attaches the view, loads the url, makes it active and visible', () => {
    const { added, created, manager } = setup();
    const tabId = manager.createTab('example.com');

    expect(added).toHaveLength(1);
    expect(created[0]?.calls.loaded).toEqual(['https://example.com']);
    const tabs = manager.listTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ active: true, tabId });
    expect(created[0]?.calls.visible.at(-1)).toBe(true);
  });

  it('shows only the active tab; selecting hides the rest', () => {
    const { created, manager } = setup();
    manager.createTab('a.com');
    const second = manager.createTab('b.com');

    // Second is active now → first invisible, second visible.
    expect(created[0]?.calls.visible.at(-1)).toBe(false);
    expect(created[1]?.calls.visible.at(-1)).toBe(true);

    manager.selectTab(manager.listTabs()[0]?.tabId ?? '');
    expect(created[0]?.calls.visible.at(-1)).toBe(true);
    expect(created[1]?.calls.visible.at(-1)).toBe(false);
    expect(manager.listTabs().find((tab) => tab.tabId === second)?.active).toBe(false);
  });

  it('applies the reported bounds to the active view and re-applies on activation', () => {
    const { created, manager } = setup();
    manager.createTab('a.com');
    const rect = { height: 400, width: 600, x: 10, y: 20 };
    manager.setBounds(rect);
    expect(created[0]?.calls.bounds.at(-1)).toEqual(rect);

    manager.createTab('b.com');
    expect(created[1]?.calls.bounds.at(-1)).toEqual(rect);
  });

  it('occludes the active view (modal open) and restores it, without touching geometry while hidden', () => {
    const { created, manager } = setup();
    manager.createTab('a.com');
    manager.setBounds({ height: 400, width: 600, x: 0, y: 0 });
    const boundsCallsBefore = created[0]?.calls.bounds.length ?? 0;

    manager.setOccluded(true);
    expect(created[0]?.calls.visible.at(-1)).toBe(false);
    // No new bounds applied while hidden.
    expect(created[0]?.calls.bounds.length).toBe(boundsCallsBefore);

    manager.setOccluded(false);
    expect(created[0]?.calls.visible.at(-1)).toBe(true);
    expect(created[0]?.calls.bounds.length).toBe(boundsCallsBefore + 1);
  });

  it('keeps a newly created tab hidden if a modal is currently occluding the pane', () => {
    const { created, manager } = setup();
    manager.createTab('a.com');
    manager.setOccluded(true);
    manager.createTab('b.com');
    // The new active tab must NOT paint over the open modal.
    expect(created[1]?.calls.visible.at(-1)).toBe(false);
  });

  it('turns http/https popups into new tabs instead of OS windows', () => {
    const { added, created, manager } = setup();
    manager.createTab('a.com');
    const handler = (
      created[0] as unknown as { __openHandler: (d: { url: string }) => { action: string } }
    ).__openHandler;
    const result = handler({ url: 'https://popup.example' });

    expect(result.action).toBe('deny');
    expect(manager.listTabs()).toHaveLength(2);
    expect(added).toHaveLength(2);
    expect(created[1]?.calls.loaded).toEqual(['https://popup.example']);
  });

  it('drops a dangerous-scheme popup (window.open("file:///...")) — no new tab', () => {
    const { manager, created } = setup();
    manager.createTab('a.com');
    const handler = (
      created[0] as unknown as { __openHandler: (d: { url: string }) => { action: string } }
    ).__openHandler;
    const result = handler({ url: 'file:///Users/me/.aws/credentials' });
    expect(result.action).toBe('deny');
    expect(manager.listTabs()).toHaveLength(1);
  });

  it('refuses to load a blocked scheme, showing about:blank instead', () => {
    const { created, manager } = setup();
    const tabId = manager.createTab('a.com');
    manager.navigate(tabId, 'file:///etc/passwd');
    expect(created[0]?.calls.loaded.at(-1)).toBe('about:blank');
  });

  it('reports (not throws) a navigation load rejection', async () => {
    const errors: Array<{ error: string; url: string }> = [];
    const created: FakeView[] = [];
    let counter = 0;
    const manager = new BrowserViewManager({
      createView: () => {
        const view = createFakeView(1);
        // Make loadURL reject like a real bad-host navigation.
        view.webContents.loadURL = () => Promise.reject(new Error('ERR_NAME_NOT_RESOLVED'));
        created.push(view);
        return view;
      },
      hostWindow: {
        contentView: { addChildView: () => undefined, removeChildView: () => undefined },
        isDestroyed: () => false,
      },
      mintTabId: () => `tab-${++counter}`,
      onNavigationError: (event) => errors.push(event),
      onTabsChanged: () => undefined,
      partition: 'persist:test',
    });
    manager.createTab('bad.example');
    await Promise.resolve();
    expect(errors.at(-1)?.error).toContain('ERR_NAME_NOT_RESOLVED');
  });

  it('returns false for tab-targeting ops on an unknown tab id', () => {
    const { manager } = setup();
    manager.createTab('a.com');
    expect(manager.closeTab('nope')).toBe(false);
    expect(manager.selectTab('nope')).toBe(false);
    expect(manager.navigate('nope', 'x.com')).toBe(false);
    expect(manager.closeTab(manager.listTabs()[0]?.tabId ?? '')).toBe(true);
  });

  it('navigate loads urls ONLY — "back"/"forward" are searched, not history commands', () => {
    const { created, manager } = setup();
    const tabId = manager.createTab('a.com');
    manager.navigate(tabId, 'other.com');
    expect(created[0]?.calls.loaded.at(-1)).toBe('https://other.com');
    // Typing "back" in the URL bar must search, not move history.
    manager.navigate(tabId, 'back');
    expect(created[0]?.calls.loaded.at(-1)).toBe('https://duckduckgo.com/?q=back');
    expect(created[0]?.webContents.goBack).not.toHaveBeenCalled();
  });

  it('goBack/goForward only move history when it allows; reload preserves both stacks', () => {
    const { created, manager } = setup();
    const tabId = manager.createTab('a.com');

    manager.goBack(tabId);
    expect(created[0]?.webContents.goBack).not.toHaveBeenCalled();
    created[0]!.navState.back = true;
    manager.goBack(tabId);
    expect(created[0]?.webContents.goBack).toHaveBeenCalledTimes(1);

    manager.goForward(tabId);
    expect(created[0]?.webContents.goForward).not.toHaveBeenCalled();
    created[0]!.navState.forward = true;
    manager.goForward(tabId);
    expect(created[0]?.webContents.goForward).toHaveBeenCalledTimes(1);

    // reload() calls webContents.reload (keeps history), never a fresh loadURL.
    const loadsBefore = created[0]?.calls.loaded.length ?? 0;
    manager.reload(tabId);
    expect(created[0]?.webContents.reload).toHaveBeenCalledTimes(1);
    expect(created[0]?.calls.loaded.length).toBe(loadsBefore);

    // All history ops return false for an unknown tab.
    expect(manager.goBack('nope')).toBe(false);
    expect(manager.goForward('nope')).toBe(false);
    expect(manager.reload('nope')).toBe(false);
  });

  it('never reveals the active view at a zero rect (bounds not yet reported)', () => {
    const created: FakeView[] = [];
    let counter = 0;
    const manager = new BrowserViewManager({
      createView: () => {
        const view = createFakeView(created.length + 1);
        created.push(view);
        return view;
      },
      hostWindow: {
        contentView: { addChildView: () => undefined, removeChildView: () => undefined },
        isDestroyed: () => false,
      },
      mintTabId: () => `tab-${++counter}`,
      onTabsChanged: () => undefined,
      partition: 'persist:test',
    });
    // No setBounds yet → the view must stay hidden, not paint at 0×0.
    manager.createTab('a.com');
    expect(created[0]?.calls.visible.at(-1)).toBe(false);
    manager.setBounds({ height: 200, width: 300, x: 0, y: 0 });
    expect(created[0]?.calls.visible.at(-1)).toBe(true);
    // Bounds applied BEFORE the reveal (last bounds call precedes last visible).
    expect(created[0]?.calls.bounds.at(-1)).toEqual({ height: 200, width: 300, x: 0, y: 0 });
  });

  it('closing the active tab activates the most recent remaining tab', () => {
    const { manager, removed } = setup();
    const first = manager.createTab('a.com');
    const second = manager.createTab('b.com');
    manager.createTab('c.com'); // active

    manager.closeTab(manager.listTabs().find((t) => t.active)?.tabId ?? '');
    expect(removed).toHaveLength(1);
    const active = manager.listTabs().find((tab) => tab.active);
    expect(active?.tabId).toBe(second);
    expect(manager.listTabs().map((t) => t.tabId)).toEqual([first, second]);
  });

  it('closing the last tab leaves no active tab and no crash', () => {
    const { manager } = setup();
    const only = manager.createTab('a.com');
    manager.closeTab(only);
    expect(manager.listTabs()).toEqual([]);
  });

  it('re-emits tab state when a view navigates or its title changes', () => {
    const { created, manager, onTabsChanged } = setup();
    manager.createTab('a.com');
    onTabsChanged.mockClear();
    created[0]!.navState.title = 'Example';
    created[0]?.emit('page-title-updated');
    expect(onTabsChanged).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ title: 'Example' })])
    );
  });

  it('a failing host attach leaves NO phantom tab behind (live-regression guard)', () => {
    // When attaching the native view throws (the 2026-08-07 conversion-failure
    // regression), the half-created tab must not stay registered — a later
    // listTabs() resync would paint a dead tab with no native view behind it
    // ("it just created a new tab and nothing else").
    const created: FakeView[] = [];
    const manager = new BrowserViewManager({
      createView: () => {
        const view = createFakeView(created.length + 1);
        created.push(view);
        return view;
      },
      hostWindow: {
        contentView: {
          addChildView: () => {
            throw new TypeError('conversion failure');
          },
          removeChildView: () => undefined,
        },
        isDestroyed: () => false,
      },
      mintTabId: () => 'tab-1',
      onTabsChanged: vi.fn(),
      partition: 'persist:browser-pane-test',
    });

    expect(() => manager.createTab('https://example.com')).toThrow('conversion failure');
    expect(manager.listTabs()).toEqual([]);
    // The orphaned view's page process must not keep running either.
    expect(created[0]?.calls.closed).toBe(true);
  });

  it('records a navigation error per tab (blocked scheme + failed load) and clears it on the next load', async () => {
    const { created, manager } = setup();
    const tabId = manager.createTab('https://ok.example');
    expect(manager.getNavigationError(tabId)).toBeNull();

    // Blocked scheme: shown as about:blank AND queryable — never a silent ok.
    manager.navigate(tabId, 'file:///etc/passwd');
    expect(manager.getNavigationError(tabId)).toContain('blocked scheme');

    // Failed load: the loadURL rejection is recorded.
    const view = created[0];
    if (!view) {
      throw new Error('view missing');
    }
    view.webContents.loadURL = () => Promise.reject(new Error('ERR_NAME_NOT_RESOLVED'));
    manager.navigate(tabId, 'https://nope.invalid');
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getNavigationError(tabId)).toContain('ERR_NAME_NOT_RESOLVED');

    // A new clean load clears it.
    view.webContents.loadURL = () => Promise.resolve();
    manager.navigate(tabId, 'https://ok.example');
    expect(manager.getNavigationError(tabId)).toBeNull();
    expect(manager.getNavigationError('nope')).toBeNull();
  });

  it('re-emits tab state on load start/stop so pushed isLoading never latches', () => {
    const { created, manager, onTabsChanged } = setup();
    manager.createTab('https://x.example');
    const before = onTabsChanged.mock.calls.length;
    created[0]?.emit('did-start-loading');
    created[0]?.emit('did-stop-loading');
    expect(onTabsChanged.mock.calls.length).toBe(before + 2);
  });

  it('dispose destroys every view and detaches it', () => {
    const { manager, removed } = setup();
    manager.createTab('a.com');
    manager.createTab('b.com');
    manager.dispose();
    expect(removed).toHaveLength(2);
    expect(manager.listTabs()).toEqual([]);
  });

  it('getActiveWebContentsId returns the active tab webContents id, null when empty', () => {
    const { manager } = setup();
    expect(manager.getActiveWebContentsId()).toBeNull();
    manager.createTab('a.com'); // view 1
    manager.createTab('b.com'); // view 2, now active
    expect(manager.getActiveWebContentsId()).toBe(2);
    manager.selectTab(manager.listTabs()[0]?.tabId ?? '');
    expect(manager.getActiveWebContentsId()).toBe(1);
    manager.dispose();
    expect(manager.getActiveWebContentsId()).toBeNull();
  });

  it('dispose resets geometry so a reused manager never reveals a new tab at the stale rect', () => {
    // The manager instance is reused across a renderer reload / factory reset:
    // dispose() runs, then the SAME manager serves the fresh renderer. A tab
    // created before the new renderer reports geometry must stay hidden, not
    // paint at the pre-dispose rect.
    const { created, manager } = setup(); // seeds bounds 400×300
    manager.createTab('a.com');
    expect(created[0]?.calls.visible.at(-1)).toBe(true); // shown at seeded bounds

    manager.dispose();
    manager.createTab('b.com'); // before any new setBounds/setOccluded

    const reused = created.at(-1);
    expect(reused?.calls.visible).not.toContain(true);
    expect(reused?.calls.visible.at(-1)).toBe(false);
  });
});
