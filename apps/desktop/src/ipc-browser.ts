/**
 * Register the desktop `browser` IPC domain (BST-1174) — thin registrar over
 * {@link createBrowserIpcHandlers}.
 *
 * The dispatcher decodes every renderer argument with `browserArgs`.
 * `tabsChanged` is a one-way main→renderer push (see desktop-ipc-channels) and
 * is deliberately NOT registered here.
 */
import { ipcMain } from 'electron';
import { type BrowserIpcHandlers, browserArgs } from './browser-ipc-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

export function registerBrowserIpcHandlers(handlers: BrowserIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const channels = DESKTOP_IPC_CHANNELS.browser;

  registry.handle('browser', channels.createTab, browserArgs.createTab, (_event, threadId, url) =>
    handlers.createTab(threadId, url)
  );
  registry.handle('browser', channels.closeTab, browserArgs.closeTab, (_event, tabId) =>
    handlers.closeTab(tabId)
  );
  registry.handle('browser', channels.navigate, browserArgs.navigate, (_event, tabId, url) =>
    handlers.navigate(tabId, url)
  );
  registry.handle('browser', channels.goBack, browserArgs.goBack, (_event, tabId) =>
    handlers.goBack(tabId)
  );
  registry.handle('browser', channels.goForward, browserArgs.goForward, (_event, tabId) =>
    handlers.goForward(tabId)
  );
  registry.handle('browser', channels.reload, browserArgs.reload, (_event, tabId) =>
    handlers.reload(tabId)
  );
  registry.handle('browser', channels.setBounds, browserArgs.setBounds, (_event, rect) =>
    handlers.setBounds(rect)
  );
  registry.handle('browser', channels.setOccluded, browserArgs.setOccluded, (_event, occluded) =>
    handlers.setOccluded(occluded)
  );
  registry.handle('browser', channels.showTab, browserArgs.showTab, (_event, tabId) =>
    handlers.showTab(tabId)
  );
  registry.handle('browser', channels.listTabs, browserArgs.listTabs, () => handlers.listTabs());

  return () => {
    registry.unregisterAll();
  };
}
