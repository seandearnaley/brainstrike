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
  type BrowserPaneView,
  type BrowserTabState,
  BrowserViewManager,
} from './browser-view-manager';

const logger = createLogger('BrowserPaneHost');

/**
 * Build a `WebContentsView` on the pane session partition, adapted to the
 * manager's narrow {@link BrowserPaneView} interface.
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
  return view as unknown as BrowserPaneView;
}

export interface BrowserPaneHost {
  dispose(): void;
  readonly manager: BrowserViewManager;
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

  const manager = new BrowserViewManager({
    createView: createPaneView,
    hostWindow: hostWindow as unknown as BrowserPaneHostWindow,
    // Ephemeral session ids — never persisted, so a plain uuid suffices.
    mintTabId: () => randomUUID(),
    onTabsChanged: pushTabs,
    partition: BROWSER_PANE_PARTITION,
  });

  logger.info('Browser pane host created');
  return {
    dispose() {
      manager.dispose();
    },
    manager,
  };
}

// The manager's structural host-window interface; a real BrowserWindow's
// `contentView` satisfies `addChildView`/`removeChildView`.
type BrowserPaneHostWindow = ConstructorParameters<typeof BrowserViewManager>[0]['hostWindow'];
