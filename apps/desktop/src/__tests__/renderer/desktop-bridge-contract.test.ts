import { describe, expect, it } from 'vitest';
import { validateDesktopBridgeContract } from '../../renderer/desktop-bridge-contract';

describe('validateDesktopBridgeContract', () => {
  it('returns missing critical bridge members when the preload surface is incomplete', () => {
    const result = validateDesktopBridgeContract({
      electronAPI: {
        db: {
          query: async () => ({ rows: [] }),
        },
      },
      logging: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected contract validation to fail.');
    }
    expect(result.missing).toContain('window.electronAPI.fileSystem.requestDirectoryAccess');
    expect(result.missing).toContain('window.electronAPI.db.insertChunksAndEnqueueEmbeddingJobs');
    expect(result.missing).toContain('window.logging.getPreferences');
  });

  it('passes when the required visible-ui desktop bridges are present', () => {
    const result = validateDesktopBridgeContract({
      electronAPI: {
        db: {
          clearAll: async () => ({ deletedChunks: 0, deletedFiles: 0, success: true }),
          diagnostics: async () => null,
          exec: async () => undefined,
          insertChunksAndEnqueueEmbeddingJobs: async () => undefined,
          query: async () => ({ rows: [] }),
          resetLocal: async () => ({ success: true }),
          test: async () => ({ dbLocation: '/tmp/db', message: 'ok', success: true }),
        },
        fileSystem: {
          exists: async () => true,
          readDirectory: async () => [],
          readFile: async () => '',
          requestDirectoryAccess: async () => ({
            kind: 'directory',
            name: 'root',
            path: '/tmp/root',
            platform: 'electron',
          }),
          restoreLastFolder: async () => null,
          saveLastFolder: async () => undefined,
        },
        storage: {
          clear: async () => undefined,
          getAllKeys: async () => [],
          getItem: async () => null,
          removeItem: async () => undefined,
          setItem: async () => undefined,
        },
      },
      logging: {
        getBufferedLogs: async () => [],
        getPreferences: async () => ({
          capabilities: {
            canSelectDestination: true,
            defaultDestination: null,
            fileLoggingSupported: true,
            reason: null,
          },
          preferences: {
            consoleEnabled: true,
            consoleLevel: 'info',
            file: {
              append: true,
              destination: null,
              enabled: false,
              level: 'info',
              mkdir: true,
            },
            includeTimestamp: true,
            level: 'info',
            redactPaths: [],
          },
        }),
        ingestBufferedRecord: () => undefined,
        onPreferencesUpdated: () => undefined,
        openDestination: async () => true,
        selectDestination: async () => null,
        setPreferences: async () => ({
          capabilities: {
            canSelectDestination: true,
            defaultDestination: null,
            fileLoggingSupported: true,
            reason: null,
          },
          preferences: {
            consoleEnabled: true,
            consoleLevel: 'info',
            file: {
              append: true,
              destination: null,
              enabled: false,
              level: 'info',
              mkdir: true,
            },
            includeTimestamp: true,
            level: 'info',
            redactPaths: [],
          },
        }),
      },
    });

    expect(result.ok).toBe(true);
  });
});
