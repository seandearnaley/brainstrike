// Electron preload script - must use CommonJS syntax
const { contextBridge, ipcRenderer, clipboard } = require('electron');
const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';
const ASSISTANT_ROOT_TREE_SELECTION_EVENT = 'assistant:root-tree-selection-update';
const ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT = 'assistant:preview-context-selection-update';

import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type {
  LayoutLoadResult,
  LayoutPersistenceResult,
  PanelPersistenceState,
} from '@brainstrike/ui';
import type { LoggingPreferences, LogRecord } from '@brainstrike/utils';
import type { LoggingSettingsPayload } from './logging-shared';

// Expose storage APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  storage: {
    getItem: (key: string) => ipcRenderer.invoke('storage:getItem', key),
    setItem: (key: string, value: string) => ipcRenderer.invoke('storage:setItem', key, value),
    removeItem: (key: string) => ipcRenderer.invoke('storage:removeItem', key),
    clear: () => ipcRenderer.invoke('storage:clear'),
    getAllKeys: () => ipcRenderer.invoke('storage:getAllKeys'),
  },
  fileSystem: {
    requestDirectoryAccess: () => ipcRenderer.invoke('fs:requestDirectoryAccess'),
    readDirectory: (handle: DirectoryHandle) => ipcRenderer.invoke('fs:readDirectory', handle),
    readFile: (handle: FileHandle) => ipcRenderer.invoke('fs:readFile', handle),
    readFileByPath: (absolutePath: string) => ipcRenderer.invoke('fs:readFileByPath', absolutePath),
    exists: (path: string) => ipcRenderer.invoke('fs:exists', path),
    restoreLastFolder: () => ipcRenderer.invoke('fs:restoreLastFolder'),
    saveLastFolder: (folderPath: string) => ipcRenderer.invoke('fs:saveLastFolder', folderPath),
  },
  // Panel layout persistence
  saveLayout: (state: PanelPersistenceState): Promise<LayoutPersistenceResult> =>
    ipcRenderer.invoke('layout:save', state),
  loadLayout: (): Promise<LayoutLoadResult> => ipcRenderer.invoke('layout:load'),
  // Database operations
  db: {
    ping: () => ipcRenderer.invoke('db:ping'),
    query: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:query', sql, params),
    exec: (sql: string) => ipcRenderer.invoke('db:exec', sql),
    test: () => ipcRenderer.invoke('db:test'),
    clearAll: (confirmationToken?: string) => ipcRenderer.invoke('db:clearAll', confirmationToken),
    resetLocal: () => ipcRenderer.invoke('db:resetLocal'),
  },
  dbLive: {
    start: (options: {
      query: string;
      params?: readonly unknown[];
      key?: string;
      mode?: 'query' | 'incremental';
      offset?: number;
      limit?: number;
    }) => ipcRenderer.invoke('db:live-query:start', options),
    stop: (id: number) => ipcRenderer.invoke('db:live-query:stop', id),
    refresh: (payload: { id: number; offset?: number; limit?: number }) =>
      ipcRenderer.invoke('db:live-query:refresh', payload),
    onUpdate: (callback: (payload: { id: number; results: unknown }) => void) => {
      const listener = (_event: unknown, data: { id: number; results: unknown }) => callback(data);
      ipcRenderer.on('db:live-query:update', listener);
      return () => {
        ipcRenderer.removeListener('db:live-query:update', listener);
      };
    },
  },
  // Database path (legacy - kept for compatibility)
  getUserDataPath: () => ipcRenderer.invoke('db:getUserDataPath'),
});

// Secure Secrets API
contextBridge.exposeInMainWorld('secrets', {
  saveKey: (provider: string, value: string) => ipcRenderer.invoke('secrets:save', provider, value),
  getKey: (provider: string) => ipcRenderer.invoke('secrets:get', provider),
  deleteKey: (provider: string) => ipcRenderer.invoke('secrets:delete', provider),
  list: () => ipcRenderer.invoke('secrets:list'),
  listStored: () => ipcRenderer.invoke('secrets:listStored'),
  clearAll: () => ipcRenderer.invoke('secrets:clearAll', SECRETS_CLEAR_CONFIRMATION_TOKEN),
});

// Settings Store API (factory reset support)
contextBridge.exposeInMainWorld('settings', {
  clearAll: () => ipcRenderer.invoke('settings:clearAll'),
});

// Local Agent API (non-streaming aggregate; renderer can pseudo-stream chunks)
contextBridge.exposeInMainWorld('agent', {
  chat: (messages: unknown[], runtime?: unknown) =>
    ipcRenderer.invoke('agent:chat', messages, runtime),
});

// MCP Config API (desktop-only)
contextBridge.exposeInMainWorld('mcp', {
  getConfig: () => ipcRenderer.invoke('mcp:config:get'),
  watch: () => ipcRenderer.invoke('mcp:config:watch'),
  unwatch: () => ipcRenderer.invoke('mcp:config:unwatch'),
  getPath: () => ipcRenderer.invoke('mcp:config:getPath'),
  setPath: (configPath: string | null) => ipcRenderer.invoke('mcp:config:setPath', configPath),
  selectPath: () => ipcRenderer.invoke('mcp:config:selectPath'),
  createSampleConfig: () => ipcRenderer.invoke('mcp:config:createSample'),
  // Tool management
  listTools: () => ipcRenderer.invoke('mcp:tools:list'),
  enableTools: (toolIds: string[]) => ipcRenderer.invoke('mcp:tools:enable', toolIds),
  disableTools: (toolIds: string[]) => ipcRenderer.invoke('mcp:tools:disable', toolIds),
  enableServerTools: (serverName: string) =>
    ipcRenderer.invoke('mcp:tools:enableServer', serverName),
  disableServerTools: (serverName: string) =>
    ipcRenderer.invoke('mcp:tools:disableServer', serverName),
  resetTools: () => ipcRenderer.invoke('mcp:tools:reset'),
  getToolStats: () => ipcRenderer.invoke('mcp:tools:getStats'),
});

// Tool execution API (for playground testing)
contextBridge.exposeInMainWorld('tools', {
  execute: (toolId: string, input: unknown) => ipcRenderer.invoke('tools:execute', toolId, input),
  onRootTreeSelectionUpdate: (
    callback: (payload: {
      folderId: string;
      filePaths: string[];
      mode: 'replace' | 'add' | 'remove';
    }) => void
  ) => {
    const listener = (
      _event: unknown,
      payload: {
        folderId: string;
        filePaths: string[];
        mode: 'replace' | 'add' | 'remove';
      }
    ) => callback(payload);
    ipcRenderer.on(ASSISTANT_ROOT_TREE_SELECTION_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(ASSISTANT_ROOT_TREE_SELECTION_EVENT, listener);
    };
  },
  onPreviewContextSelectionUpdate: (
    callback: (payload: {
      folderId: string;
      filePaths: string[];
      mode: 'replace' | 'add' | 'remove';
    }) => void
  ) => {
    const listener = (
      _event: unknown,
      payload: {
        folderId: string;
        filePaths: string[];
        mode: 'replace' | 'add' | 'remove';
      }
    ) => callback(payload);
    ipcRenderer.on(ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(ASSISTANT_PREVIEW_CONTEXT_SELECTION_EVENT, listener);
    };
  },
});

// Assistant UI (data stream) endpoint helper
contextBridge.exposeInMainWorld('assistant', {
  getUrl: () => ipcRenderer.invoke('assistant:get-url'),
});

contextBridge.exposeInMainWorld('logging', {
  getPreferences: (): Promise<LoggingSettingsPayload> =>
    ipcRenderer.invoke('logging:get-preferences'),
  setPreferences: (preferences: LoggingPreferences): Promise<LoggingSettingsPayload> =>
    ipcRenderer.invoke('logging:set-preferences', preferences),
  selectDestination: (): Promise<string | null> => ipcRenderer.invoke('logging:select-destination'),
  openDestination: (target: string | null): Promise<boolean> =>
    ipcRenderer.invoke('logging:open-destination', target ?? null),
  getBufferedLogs: (): Promise<LogRecord[]> => ipcRenderer.invoke('logging:get-buffered-logs'),
  onPreferencesUpdated: (callback: (preferences: LoggingPreferences) => void) => {
    const listener = (_event: unknown, prefs: LoggingPreferences) => callback(prefs);
    ipcRenderer.on('logging:preferences-updated', listener);
    return () => {
      ipcRenderer.removeListener('logging:preferences-updated', listener);
    };
  },
});

// System Clipboard helper (renderer-friendly)
contextBridge.exposeInMainWorld('clipboard', {
  writeText: (text: string) => {
    try {
      clipboard.writeText(String(text ?? ''));
      return true;
    } catch {
      return false;
    }
  },
  readText: () => {
    try {
      return clipboard.readText();
    } catch {
      return '';
    }
  },
});
