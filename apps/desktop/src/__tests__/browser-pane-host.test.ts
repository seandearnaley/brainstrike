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
  setWebRTCIPHandlingPolicy = vi.fn();
  on = vi.fn();
  once = vi.fn();
  /** Replay `event` to the listeners the view manager registered. */
  emit(event: string, ...args: unknown[]): void {
    for (const [name, listener] of this.on.mock.calls as [string, Listener][]) {
      if (name === event) {
        listener(...args);
      }
    }
  }
}

const createdViews: FakeWebContentsView[] = [];

class FakeWebContentsView {
  readonly webContents = new FakeWebContents();
  readonly partition: string;
  setBounds = vi.fn();
  setVisible = vi.fn();
  constructor(options: { webPreferences: { partition: string } }) {
    this.partition = options.webPreferences.partition;
    createdViews.push(this);
  }
}

vi.mock('electron', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, WebContentsView: FakeWebContentsView };
});

/**
 * A host window that captures its `did-start-navigation` listener and BEHAVES
 * LIKE ELECTRON once `destroy()`ed (BST-1843): `isDestroyed()` turns true and
 * every other property read (`contentView`, `webContents`) throws
 * `TypeError('Object has been destroyed')`, exactly as a destroyed
 * `BrowserWindow` does.
 */
function fakeHostWindow() {
  const navListeners: Listener[] = [];
  const attached: unknown[] = [];
  let destroyed = false;
  const contentView = {
    addChildView: (view: unknown) => attached.push(view),
    removeChildView: (view: unknown) => {
      const idx = attached.indexOf(view);
      if (idx !== -1) {
        attached.splice(idx, 1);
      }
    },
  };
  const webContents = {
    off: vi.fn(),
    on: (event: string, listener: Listener) => {
      if (event === 'did-start-navigation') {
        navListeners.push(listener);
      }
    },
    send: vi.fn(),
  };
  const guard = <T>(value: T): T => {
    if (destroyed) {
      throw new TypeError('Object has been destroyed');
    }
    return value;
  };
  const window = {
    get contentView() {
      return guard(contentView);
    },
    isDestroyed: () => destroyed,
    get webContents() {
      return guard(webContents);
    },
  };
  return {
    attached,
    destroy: () => {
      destroyed = true;
    },
    navListeners,
    // Captured up front so assertions can still read them after `destroy()`.
    send: webContents.send,
    window,
    windowWebContents: webContents,
  };
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
});

describe('createBrowserPaneHost — dispose after the window closed (BST-1843)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('host.dispose() on a destroyed window (win "closed") throws nothing and still releases every page', async () => {
    // main.ts runs `browserPaneHost.dispose()` from `win.once('closed', …)`,
    // when the BrowserWindow is already destroyed. A throw there aborts the
    // rest of the handler (the browser IPC handlers would never be disposed)
    // and surfaces as an uncaught main-process exception at every close.
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { attached, destroy, send, window } = fakeHostWindow();
    const host = createBrowserPaneHost(window as never);
    host.manager.createTab('https://a.example');
    host.manager.createTab('https://b.example');
    expect(attached).toHaveLength(2);
    const views = attached.slice() as FakeWebContentsView[];

    destroy();
    send.mockClear();

    expect(() => host.dispose()).not.toThrow();

    // Electron does not destroy a WebContentsView's webContents with its
    // window: they must be closed explicitly on this path too.
    for (const view of views) {
      expect(view.webContents.close).toHaveBeenCalledTimes(1);
    }
    expect(host.manager.listTabs()).toEqual([]);
    // Nothing is sent to the dead renderer.
    expect(send).not.toHaveBeenCalled();
  });

  it('host.dispose() on a live window still detaches the views and unhooks the reload listener', async () => {
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { attached, window, windowWebContents } = fakeHostWindow();
    const host = createBrowserPaneHost(window as never);
    host.manager.createTab('https://a.example');
    const [view] = attached as FakeWebContentsView[];

    host.dispose();

    expect(attached).toHaveLength(0);
    expect(view?.webContents.close).toHaveBeenCalledTimes(1);
    expect(windowWebContents.off).toHaveBeenCalledWith(
      'did-start-navigation',
      expect.any(Function)
    );
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

describe('createBrowserPaneHost — agent tabs behind the egress proxy (BST-1238)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdViews.length = 0;
  });

  function fakeRoute() {
    let onRefused: ((response: unknown) => void) | undefined;
    const refusals = new Map<string, unknown>();
    const route = {
      prepare: vi.fn((listener: (response: unknown) => void, _loopback: unknown) => {
        onRefused = listener;
        return Promise.resolve();
      }),
      takeRefusal: vi.fn((host: string) => refusals.get(host)),
    };
    return { refusals, refuse: (response: unknown) => onRefused?.(response), route };
  }

  it('opens agent tabs on the agent partition with WebRTC confined to the proxy', async () => {
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { route } = fakeRoute();
    const host = createBrowserPaneHost(fakeHostWindow().window as never, route as never);
    host.manager.createTab('https://user.test/');
    host.manager.createTab('https://agent.test/', 'agent');
    expect(createdViews.map((view) => view.partition)).toEqual([
      'persist:browser-pane',
      'browser-pane-agent',
    ]);
    expect(createdViews[0]?.webContents.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled();
    expect(createdViews[1]?.webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledExactlyOnceWith(
      'disable_non_proxied_udp'
    );
    host.dispose();
  });

  it('prepares agent browsing through its route and fails the tab a refused response belonged to', async () => {
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { refuse, route } = fakeRoute();
    const host = createBrowserPaneHost(fakeHostWindow().window as never, route as never);
    await host.prepareAgentBrowsing();
    expect(route.prepare).toHaveBeenCalledOnce();
    // BST-1178: a public navigation closes loopback; an approved one admits its server.
    expect(route.prepare).toHaveBeenLastCalledWith(expect.any(Function), null);
    const admission = {
      authority: 'localhost:5173',
      origin: 'http://localhost:5173',
      webContentsId: 3,
    };
    await host.prepareAgentBrowsing(admission);
    expect(route.prepare).toHaveBeenLastCalledWith(expect.any(Function), admission);
    const tabId = host.manager.createTab('http://public.test/', 'agent');
    const webContentsId = createdViews[0]?.webContents.id;
    // A subresource refusal does not fail the page.
    refuse({
      isMainFrame: false,
      refusal: 'loopback',
      url: 'http://127.0.0.1/x.png',
      webContentsId,
    });
    expect(host.manager.getNavigationError(tabId)).toBeNull();
    refuse({
      isMainFrame: true,
      refusal: 'loopback',
      url: 'http://internal.test/admin',
      webContentsId,
    });
    expect(host.manager.getNavigationError(tabId)).toBe(
      'blocked_destination: agent browsing may not connect to internal.test, a loopback address'
    );
    host.dispose();
  });

  it('reports a host that does not resolve as a failed load, not a blocked destination', async () => {
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { refusals, route } = fakeRoute();
    refusals.set('typo.invalid', { host: 'typo.invalid', reason: 'unresolved' });
    const host = createBrowserPaneHost(fakeHostWindow().window as never, route as never);
    const tabId = host.manager.createTab('https://typo.invalid/', 'agent');
    createdViews[0]?.webContents.emit(
      'did-fail-load',
      {},
      -111,
      'ERR_TUNNEL',
      'https://typo.invalid/',
      true
    );
    expect(host.manager.getNavigationError(tabId)).toBe(
      'agent browsing could not resolve typo.invalid'
    );
    host.dispose();
  });

  it("names an agent tab's tunnel failure from the proxy's refusal, and leaves other failures alone", async () => {
    const { createBrowserPaneHost } = await import('../browser/browser-pane-host');
    const { refusals, route } = fakeRoute();
    refusals.set('metadata.test', {
      address: '169.254.169.254',
      addressClass: 'link-local',
      host: 'metadata.test',
      reason: 'destination',
    });
    const host = createBrowserPaneHost(fakeHostWindow().window as never, route as never);
    const agentTab = host.manager.createTab('https://a.test/', 'agent');
    const userTab = host.manager.createTab('https://u.test/');
    const [agentView, userView] = createdViews;
    agentView?.webContents.emit(
      'did-fail-load',
      {},
      -111,
      'ERR_TUNNEL',
      'https://metadata.test/',
      true
    );
    userView?.webContents.emit(
      'did-fail-load',
      {},
      -111,
      'ERR_TUNNEL',
      'https://metadata.test/',
      true
    );
    expect(host.manager.getNavigationError(agentTab)).toBe(
      'blocked_destination: agent browsing may not connect to metadata.test, a link-local address'
    );
    expect(host.manager.getNavigationError(userTab)).toBe(
      'ERR_TUNNEL (-111) loading https://metadata.test/'
    );
    host.dispose();
  });
});
