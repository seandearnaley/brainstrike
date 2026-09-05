/**
 * Register the desktop `browser` IPC domain (BST-1174) — thin registrar over
 * {@link createBrowserIpcHandlers}, mirroring `ipc-changes.ts`.
 *
 * Every renderer arg arrives as `unknown` and is narrowed inside the handler.
 * `tabsChanged` is a one-way main→renderer push (see desktop-ipc-channels) and
 * is deliberately NOT registered here.
 */
import { ipcMain } from 'electron';
import type { BrowserIpcHandlers } from './browser-ipc-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerBrowserIpcHandlers(handlers: BrowserIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const channels = DESKTOP_IPC_CHANNELS.browser;

  registry.registerAuthorizedInvoke(
    'browser',
    channels.createTab,
    { roles: ['visible-ui'] },
    (_event, url: unknown) => handlers.createTab(url)
  );
  registry.registerAuthorizedInvoke(
    'browser',
    channels.closeTab,
    { roles: ['visible-ui'] },
    (_event, tabId: unknown) => handlers.closeTab(tabId)
  );
  registry.registerAuthorizedInvoke(
    'browser',
    channels.selectTab,
    { roles: ['visible-ui'] },
    (_event, tabId: unknown) => handlers.selectTab(tabId)
  );
  registry.registerAuthorizedInvoke(
    'browser',
    channels.navigate,
    { roles: ['visible-ui'] },
    (_event, tabId: unknown, url: unknown) => handlers.navigate(tabId, url)
  );
  registry.registerAuthorizedInvoke(
    'browser',
    channels.goBack,
    { roles: ['visible-ui'] },
    (_event, tabId: unknown) => handlers.goBack(tabId)
  );
  registry.registerAuthorizedInvoke(
    'browser',
    channels.goForward,
    { roles: ['visible-ui'] },
    (_event, tabId: unknown) => handlers.goForward(tabId)
  );
  registry.registerAuthorizedInvoke(
    'browser',
    channels.reload,
    { roles: ['visible-ui'] },
    (_event, tabId: unknown) => handlers.reload(tabId)
  );
  registry.registerAuthorizedInvoke(
    'browser',
    channels.setBounds,
    { roles: ['visible-ui'] },
    (_event, rect: unknown) => handlers.setBounds(rect)
  );
  registry.registerAuthorizedInvoke(
    'browser',
    channels.setOccluded,
    { roles: ['visible-ui'] },
    (_event, occluded: unknown) => handlers.setOccluded(occluded)
  );
  registry.registerAuthorizedInvoke('browser', channels.listTabs, { roles: ['visible-ui'] }, () =>
    handlers.listTabs()
  );

  return () => {
    registry.unregisterAll();
  };
}
