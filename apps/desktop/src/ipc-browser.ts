/**
 * Register the desktop `browser` IPC domain (BST-1174) — thin registrar over
 * {@link createBrowserIpcHandlers}.
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

  registry.handle('browser', channels.createTab, (_event, threadId: unknown, url: unknown) =>
    handlers.createTab(threadId, url)
  );
  registry.handle('browser', channels.closeTab, (_event, tabId: unknown) =>
    handlers.closeTab(tabId)
  );
  registry.handle('browser', channels.navigate, (_event, tabId: unknown, url: unknown) =>
    handlers.navigate(tabId, url)
  );
  registry.handle('browser', channels.goBack, (_event, tabId: unknown) => handlers.goBack(tabId));
  registry.handle('browser', channels.goForward, (_event, tabId: unknown) =>
    handlers.goForward(tabId)
  );
  registry.handle('browser', channels.reload, (_event, tabId: unknown) => handlers.reload(tabId));
  registry.handle('browser', channels.setBounds, (_event, rect: unknown) =>
    handlers.setBounds(rect)
  );
  registry.handle('browser', channels.setOccluded, (_event, occluded: unknown) =>
    handlers.setOccluded(occluded)
  );
  registry.handle('browser', channels.showTab, (_event, tabId: unknown) => handlers.showTab(tabId));
  registry.handle('browser', channels.listTabs, () => handlers.listTabs());

  return () => {
    registry.unregisterAll();
  };
}
