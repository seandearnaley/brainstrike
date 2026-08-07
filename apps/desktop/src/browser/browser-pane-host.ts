/**
 * Wires the {@link BrowserViewManager} to real Electron primitives (BST-1174):
 * a `WebContentsView` factory bound to the pane's hardened session partition,
 * the visible window as host, uuidv7 tab ids, and a tabs-changed push to every
 * renderer. Kept separate from the manager so the manager stays unit-testable
 * without Electron.
 *
 * The view's own `webContents` gets a PERMISSIVE navigation posture — the
 * visible window's deny-all (`create-window.ts` `configureSecurity`) binds
 * only that window's `webContents`, never child views, so browser tabs reach
 * the real web by default. Popups are intercepted by the manager into new tabs.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@brainstrike/logging';
import { type BrowserWindow, WebContentsView } from 'electron';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { BROWSER_PANE_PARTITION, getBrowserPaneSession } from './browser-session';
import {
  type BrowserHostWindow,
  type BrowserPaneView,
  type BrowserTabState,
  BrowserViewManager,
  type PaneWebContents,
} from './browser-view-manager';

const logger = createLogger('BrowserPaneHost');

/**
 * Build a `WebContentsView` on the pane session partition, adapted to the
 * manager's narrow {@link BrowserPaneView} interface.
 *
 * Every method is mapped EXPLICITLY rather than blanket-cast, so TypeScript
 * confirms each interface method actually exists on the real Electron types —
 * the one guard against a `WebContentsView`/`WebContents` API drift silently
 * shipping a broken pane. Only `webContents.on` needs a local cast (its
 * Electron overload union is not assignable to the narrow `on(event, listener)`
 * shape).
 */
function createPaneView(partition: string): BrowserPaneView {
  const view = new WebContentsView({
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      // A browser tab has no preload and no Node — it renders untrusted web.
      nodeIntegration: false,
      partition,
      sandbox: true,
      webSecurity: true,
    },
  });
  const { webContents } = view;
  const paneWebContents: PaneWebContents = {
    canGoBack: () => webContents.navigationHistory.canGoBack(),
    canGoForward: () => webContents.navigationHistory.canGoForward(),
    close: () => webContents.close(),
    getTitle: () => webContents.getTitle(),
    getURL: () => webContents.getURL(),
    goBack: () => webContents.navigationHistory.goBack(),
    goForward: () => webContents.navigationHistory.goForward(),
    id: webContents.id,
    loadURL: (url) => webContents.loadURL(url),
    on: (event, listener) => {
      (webContents.on as (e: string, l: (...args: unknown[]) => void) => void)(event, listener);
    },
    reload: () => webContents.reload(),
    setWindowOpenHandler: (handler) => webContents.setWindowOpenHandler(handler),
  };
  return {
    setBounds: (rect) => view.setBounds(rect),
    setVisible: (visible) => view.setVisible(visible),
    webContents: paneWebContents,
  };
}

export interface BrowserPaneHost {
  dispose(): void;
  readonly manager: BrowserViewManager;
}

/**
 * Every live pane manager, so the desktop factory reset can close their
 * `WebContentsView`s BEFORE the `persist:browser-pane` partition is cleared.
 * A still-running view would otherwise rewrite cookies/localStorage into the
 * partition during the reset window, leaving site state behind (codex P1).
 */
const activeManagers = new Set<BrowserViewManager>();

/**
 * Dispose every live pane manager's tabs. Call from the factory reset BEFORE
 * clearing the pane session storage so no view can repopulate the partition
 * mid-reset. Idempotent — `dispose()` on an already-empty manager is a no-op.
 */
export function disposeActiveBrowserPaneViews(): void {
  for (const manager of activeManagers) {
    manager.dispose();
  }
}

/**
 * Construct the pane host bound to `hostWindow`. Call inside `app.whenReady()`
 * once the visible window exists.
 */
export function createBrowserPaneHost(hostWindow: BrowserWindow): BrowserPaneHost {
  // Harden the pane session partition (idempotent) before any view uses it.
  getBrowserPaneSession();

  const pushTabs = (tabs: readonly BrowserTabState[]) => {
    if (hostWindow.isDestroyed()) {
      return;
    }
    hostWindow.webContents.send(DESKTOP_IPC_CHANNELS.browser.tabsChanged, tabs);
  };

  // A real BrowserWindow's `contentView` satisfies addChildView/removeChildView
  // over the narrow BrowserPaneView; the cast is only to bridge Electron's View
  // param type to the interface.
  const host: BrowserHostWindow = {
    contentView: {
      addChildView: (view) =>
        hostWindow.contentView.addChildView(view as unknown as WebContentsView),
      removeChildView: (view) =>
        hostWindow.contentView.removeChildView(view as unknown as WebContentsView),
    },
  };

  const manager = new BrowserViewManager({
    createView: createPaneView,
    hostWindow: host,
    // Ephemeral session ids — never persisted, so a plain uuid suffices.
    mintTabId: () => randomUUID(),
    onNavigationError: ({ error, url }) => logger.debug('Pane navigation failed', { error, url }),
    onTabsChanged: pushTabs,
    partition: BROWSER_PANE_PARTITION,
  });

  // When the VISIBLE renderer itself navigates/reloads (Reload menu, crash
  // recovery, or a factory reset's `window.location.reload()`), the old
  // BrowserPaneContent is gone and cannot re-report occlusion or re-adopt its
  // tabs. Dispose every tab so (a) no orphaned WebContentsView keeps painting
  // over the fresh renderer's Explorer route, and (b) a factory reset actually
  // clears open tabs, not just the renderer mirror + session storage. The
  // fresh renderer re-seeds from an empty list.
  const onHostNavigation = (
    _event: Electron.Event,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean
  ) => {
    if (isMainFrame && !isInPlace) {
      manager.dispose();
    }
  };
  hostWindow.webContents.on('did-start-navigation', onHostNavigation);
  activeManagers.add(manager);

  logger.info('Browser pane host created');
  return {
    dispose() {
      if (!hostWindow.isDestroyed()) {
        hostWindow.webContents.off('did-start-navigation', onHostNavigation);
      }
      activeManagers.delete(manager);
      manager.dispose();
    },
    manager,
  };
}
