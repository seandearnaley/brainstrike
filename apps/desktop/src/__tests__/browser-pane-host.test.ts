import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Host wiring test for the occlusion-on-reload fix (BST-1174, review P1s):
 * when the VISIBLE renderer reloads (Reload menu / crash recovery / factory
 * reset's `window.location.reload()`), the host disposes every browser tab so
 * no orphaned `WebContentsView` keeps painting over the fresh renderer, and a
 * factory reset actually clears open tabs (not just the renderer mirror).
 *
 * The real `WebContentsView`/`BrowserWindow` are unavailable in Vitest, so we
 * inject a fake view factory and hand-build a host window that captures the
 * `did-start-navigation` listener and records child-view attach/detach.
 */

type Listener = (...args: unknown[]) => void;

let nextId = 1;

/** Canned CDP responses the fake `webContents.debugger` replays (BST-1176). */
const CDP_CANNED: Record<string, unknown> = {
  'Accessibility.getFullAXTree': {
    nodes: [{ backendDOMNodeId: 9, name: { value: 'Go' }, nodeId: '1', role: { value: 'button' } }],
  },
  'Runtime.evaluate': { result: { value: 'PAGE TEXT' } },
};

function fakeDebugger() {
  let attached = false;
  return {
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    isAttached: () => attached,
    on: vi.fn(),
    sendCommand: vi.fn((method: string) => Promise.resolve(CDP_CANNED[method] ?? {})),
  };
}

class FakeWebContents {
  readonly id = nextId++;
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => undefined,
    goForward: () => undefined,
  };
  readonly debugger = fakeDebugger();
  getTitle = () => 'Fake';
  getURL = () => 'about:blank';
  isLoading = () => false;
  loadURL = vi.fn(() => Promise.resolve());
  reload = vi.fn();
  close = vi.fn();
  setWindowOpenHandler = vi.fn();
  on = vi.fn();
  once = vi.fn();
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents();
  setBounds = vi.fn();
  setVisible = vi.fn();
}

vi.mock('electron', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, WebContentsView: FakeWebContentsView };
});

/** A host window that captures its `did-start-navigation` listener. */
function fakeHostWindow() {
  const navListeners: Listener[] = [];
  const attached: unknown[] = [];
  const window = {
    contentView: {
      addChildView: (view: unknown) => attached.push(view),
      removeChildView: (view: unknown) => {
        const idx = attached.indexOf(view);
        if (idx !== -1) {
          attached.splice(idx, 1);
        }
      },
    },
    isDestroyed: () => false,
    webContents: {
      off: vi.fn(),
      on: (event: string, listener: Listener) => {
        if (event === 'did-start-navigation') {
          navListeners.push(listener);
        }
      },
      send: vi.fn(),
    },
  };
  return { attached, navListeners, window };
}

describe('createBrowserPaneHost — dispose on renderer reload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disposes every tab when the host renderer performs a main-frame reload', async () => {
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { attached, navListeners, window } = fakeHostWindow();
    const host = createBrowserPaneHost(window as never);

    host.manager.createTab('https://example.com');
    expect(host.manager.listTabs()).toHaveLength(1);
    expect(attached).toHaveLength(1);
    expect(navListeners).toHaveLength(1);

    // Modern Electron details object — a real navigation/reload.
    // Supplying no deprecated positional args makes this fail if production
    // still reads `isInPlace` / `isMainFrame` from positions 3 and 4.
    navListeners[0]?.({ isMainFrame: true, isSameDocument: false });

    expect(host.manager.listTabs()).toHaveLength(0);
    expect(attached).toHaveLength(0);
    // The renderer is told the pane is now empty so it re-seeds from nothing.
    expect(window.webContents.send).toHaveBeenLastCalledWith(expect.any(String), []);
  });

  it('ignores same-document and subframe navigations', async () => {
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { navListeners, window } = fakeHostWindow();
    const host = createBrowserPaneHost(window as never);
    host.manager.createTab('https://example.com');

    navListeners[0]?.({ isMainFrame: true, isSameDocument: true }); // hash change
    navListeners[0]?.({ isMainFrame: false, isSameDocument: false }); // subframe
    expect(host.manager.listTabs()).toHaveLength(1);
  });

  it('disposeActiveBrowserPaneViews closes live tabs (factory-reset ordering) and unregisters on host dispose', async () => {
    const { createBrowserPaneHost, disposeActiveBrowserPaneViews } = await import(
      '../browser/browser-pane-host'
    );
    const { window } = fakeHostWindow();
    const host = createBrowserPaneHost(window as never);
    host.manager.createTab('https://example.com');
    expect(host.manager.listTabs()).toHaveLength(1);

    // Factory reset must close the views BEFORE clearing the partition.
    disposeActiveBrowserPaneViews();
    expect(host.manager.listTabs()).toHaveLength(0);

    // After host teardown the manager is unregistered — a later reset that
    // recreates a view must not be disposed through a stale registry entry.
    host.manager.createTab('https://again.example');
    host.dispose();
    disposeActiveBrowserPaneViews();
    expect(host.manager.listTabs()).toHaveLength(0); // already disposed by host.dispose, not resurrected
  });
});

describe('createBrowserPaneHost — native view identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the REAL WebContentsView instance to addChildView/removeChildView, never the wrapper', async () => {
    // Production regression (2026-08-07 live logs): the manager's plain-object
    // wrapper was cast `as unknown as WebContentsView` into the native
    // `contentView.addChildView`, which rejects non-View objects at the
    // binding layer ("Error processing argument at index 0, conversion
    // failure") — createTab threw in the real app while every fake-based test
    // stayed green. The identity contract below is the guard: what reaches
    // the host window MUST be the constructed WebContentsView itself.
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { attached, window } = fakeHostWindow();
    const host = createBrowserPaneHost(window as never);

    const tabId = host.manager.createTab('https://example.com');
    expect(attached).toHaveLength(1);
    expect(attached[0]).toBeInstanceOf(FakeWebContentsView);

    host.manager.closeTab(tabId);
    expect(attached).toHaveLength(0); // removeChildView matched the same instance
  });
});

describe('createBrowserPaneHost — CDP driver (BST-1176)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes a driver that reads the active tab over its in-process debugger', async () => {
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { window } = fakeHostWindow();
    const host = createBrowserPaneHost(window as never);
    host.manager.createTab('https://example.com');

    const page = await host.driver.getPageText(100);
    expect(page.text).toBe('PAGE TEXT');

    const snapshot = await host.driver.snapshot({ filter: 'all', maxChars: 1000 });
    expect(snapshot.refs).toEqual({ e1: 9 }); // ref → backendDOMNodeId from the canned AX tree
  });

  it('driver rejects when no tab is active (no silent no-op)', async () => {
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { window } = fakeHostWindow();
    const host = createBrowserPaneHost(window as never);
    await expect(host.driver.getPageText(100)).rejects.toThrow('No active browser tab');
  });
});
