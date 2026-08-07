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

class FakeWebContents {
  readonly id = nextId++;
  readonly navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => undefined,
    goForward: () => undefined,
  };
  getTitle = () => 'Fake';
  getURL = () => 'about:blank';
  loadURL = vi.fn(() => Promise.resolve());
  reload = vi.fn();
  close = vi.fn();
  setWindowOpenHandler = vi.fn();
  on = vi.fn();
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

    // (event, url, isInPlace, isMainFrame) — a real navigation/reload.
    navListeners[0]?.({}, 'app://renderer', false, true);

    expect(host.manager.listTabs()).toHaveLength(0);
    expect(attached).toHaveLength(0);
    // The renderer is told the pane is now empty so it re-seeds from nothing.
    expect(window.webContents.send).toHaveBeenLastCalledWith(expect.any(String), []);
  });

  it('ignores in-place (same-document) and subframe navigations', async () => {
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { navListeners, window } = fakeHostWindow();
    const host = createBrowserPaneHost(window as never);
    host.manager.createTab('https://example.com');

    navListeners[0]?.({}, '#hash', true, true); // in-place (hash change)
    navListeners[0]?.({}, 'https://ad.example', false, false); // subframe
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
