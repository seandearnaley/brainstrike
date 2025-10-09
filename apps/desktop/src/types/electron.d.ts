import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import type { PanelPersistenceState } from '@brainstrike/ui';
import type { LoggingPreferences } from '@brainstrike/utils';
import type { LoggingSettingsPayload } from '../logging-shared';

interface QueryResult {
  rows: unknown[];
  fields?: { name: string; dataType: string }[];
}

// Type definitions for the Electron API exposed via contextBridge
declare global {
  interface Window {
    electronAPI: {
      storage: {
        getItem: (key: string) => Promise<string | null>;
        setItem: (key: string, value: string) => Promise<void>;
        removeItem: (key: string) => Promise<void>;
        clear: () => Promise<void>;
        getAllKeys: () => Promise<string[]>;
      };
      fileSystem: {
        requestDirectoryAccess: () => Promise<DirectoryHandle>;
        readDirectory: (handle: DirectoryHandle) => Promise<IFileNode[]>;
        readFile: (handle: FileHandle) => Promise<string>;
        exists: (path: string) => Promise<boolean>;
        restoreLastFolder: () => Promise<DirectoryHandle | null>;
        saveLastFolder: (folderPath: string) => Promise<void>;
      };
      // Database operations
      db: {
        query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
        exec: (sql: string) => Promise<void>;
        test: () => Promise<{ success: boolean; message: string; dbLocation: string }>;
        clearAll: (confirmationToken?: string) => Promise<{
          success: boolean;
          message?: string;
          deletedFiles?: number;
          deletedChunks?: number;
        }>;
        resetLocal: () => Promise<{ success: boolean; message?: string }>;
      };
      // Layout persistence methods
      saveLayout: (state: PanelPersistenceState) => Promise<void>;
      loadLayout: () => Promise<PanelPersistenceState | undefined>;
      // Database path method (legacy)
      getUserDataPath: () => Promise<string>;
    };
    secrets: {
      saveKey: (
        provider: string,
        value: string
      ) => Promise<true | { ok: false; error: 'encryption_unavailable' | 'unknown_error' }>;
      getKey: (provider: string) => Promise<string | null>;
      deleteKey: (provider: string) => Promise<boolean>;
      list: () => Promise<string[]>;
    };
    agent: {
      chat: <T = unknown>(messages: T[], runtime?: unknown) => Promise<unknown[]>; // StreamChunk[] shape
    };
    logging: {
      getPreferences: () => Promise<LoggingSettingsPayload>;
      setPreferences: (preferences: LoggingPreferences) => Promise<LoggingSettingsPayload>;
      selectDestination: () => Promise<string | null>;
      openDestination: (target: string | null) => Promise<boolean>;
    };
    mcp: {
      getConfig: () => Promise<{
        path: string;
        exists: boolean;
        servers?: { name: string; transport: 'stdio' | 'sse' }[];
        loadedAt?: number;
      }>;
      watch: () => Promise<{ watching: boolean }>;
      unwatch: () => Promise<{ watching: false }>;
      getPath: () => Promise<string>;
      setPath: (configPath: string | null) => Promise<{ success: boolean; path: string }>;
      selectPath: () => Promise<string | null>;
      // Tool management
      listTools: () => Promise<{
        [serverName: string]: Array<{
          id: string;
          serverName: string;
          description?: string;
          inputSchema?: unknown;
          enabled: boolean;
          discoveredAt: number;
        }>;
      }>;
      enableTools: (toolIds: string[]) => Promise<void>;
      disableTools: (toolIds: string[]) => Promise<void>;
      enableServerTools: (serverName: string) => Promise<void>;
      disableServerTools: (serverName: string) => Promise<void>;
      resetTools: () => Promise<void>;
      getToolStats: () => Promise<{
        total: number;
        enabled: number;
        disabled: number;
        servers: number;
      }>;
    };
  }
}
