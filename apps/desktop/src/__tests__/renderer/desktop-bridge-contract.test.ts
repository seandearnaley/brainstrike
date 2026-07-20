import { describe, expect, it } from 'vitest';
import {
  isElectronRendererUserAgent,
  validateDesktopBridgeContract,
} from '../../renderer/desktop-bridge-contract';

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

describe('isElectronRendererUserAgent', () => {
  it('recognizes an Electron renderer user agent', () => {
    expect(
      isElectronRendererUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) brainstrike-desktop/0.1.0 Chrome/150.0.7871.46 Electron/43.0.0 Safari/537.36'
      )
    ).toBe(true);
  });

  it('rejects a plain-browser user agent (dev-server URL opened outside Electron)', () => {
    expect(
      isElectronRendererUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
      )
    ).toBe(false);
  });

  it('does not match a bare "Electron" token without the versioned form', () => {
    expect(isElectronRendererUserAgent('Mozilla/5.0 ElectronFanPage/1.0')).toBe(false);
  });
});
