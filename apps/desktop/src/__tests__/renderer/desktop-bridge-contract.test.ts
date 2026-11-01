import { describe, expect, it } from 'vitest';
import {
  isElectronRendererUserAgent,
  validateDesktopBridgeContract,
} from '../../renderer/desktop-bridge-contract';

describe('validateDesktopBridgeContract', () => {
  it('returns missing critical bridge members when the preload surface is incomplete', () => {
    const result = validateDesktopBridgeContract({
      electronAPI: {
        content: { clear: async () => ({}) },
      },
      logging: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected contract validation to fail.');
    }
    expect(result.missing).toContain('window.electronAPI.fileSystem.deleteRootData');
    expect(result.missing).toContain('window.modelCatalog.read');
    expect(result.missing).toContain('window.agentHost.onPrepareClose');
    expect(result.missing).toContain('window.logging.getPreferences');
  });

  it.each([undefined, {}, { onPrepareClose: 42 }])(
    'requires a callable lifecycle capability: %j',
    (agentHost) => {
      const result = validateDesktopBridgeContract({ agentHost });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('Expected invalid bridge');
      }
      expect(result.missing).toContain('window.agentHost.onPrepareClose');
    }
  );

  it.each([undefined, {}, { requestReload: 42 }])(
    'requires a callable desktop reload capability: %j',
    (desktopLifecycle) => {
      const result = validateDesktopBridgeContract({ desktopLifecycle });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('Expected invalid reload capability');
      }
      expect(result.missing).toContain('window.desktopLifecycle.requestReload');
    }
  );

  it('passes with the current owners and no retired database bridge', () => {
    const result = validateDesktopBridgeContract({
      agentHost: { onPrepareClose: () => () => undefined },
      desktopLifecycle: { requestReload: async () => undefined },
      electronAPI: {
        content: { clear: async () => ({}) },
        factoryReset: { resetLocal: async () => ({ success: true }) },
        fileSystem: { deleteRootData: async () => ({ ok: true, value: undefined }) },
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
      modelCatalog: { read: async () => ({}) },
      threadGroups: { readRoots: async () => [], request: async () => ({}) },
      viewFilterPresets: { request: async () => ({}) },
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
