import { describe, expect, it } from 'vitest';
import {
  fileSystemContract,
  fileSystemWatchContract,
} from '../../ipc-domains/file-system.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

const directoryHandle = {
  kind: 'directory' as const,
  name: 'workspace',
  path: '/workspace',
  platform: 'electron' as const,
};

describe('file-system IPC contracts', () => {
  it('owns the exact public bridge key set across core and watcher contracts', () => {
    expect(
      [...Object.keys(fileSystemContract), ...Object.keys(fileSystemWatchContract)].sort()
    ).toEqual([
      'addRoot',
      'addRootByPath',
      'deleteRootData',
      'exists',
      'getWatcherTelemetry',
      'listRecentRoots',
      'onWatchEvent',
      'onWatchHealth',
      'readDirectory',
      'readFile',
      'readFileByAbsolutePath',
      'readFileByPath',
      'removeRoot',
      'requestDirectoryAccess',
      'restoreLastFolder',
      'restoreRoots',
      'retryWatch',
      'saveLastFolder',
      'unwatchDirectory',
      'watchDirectory',
    ]);
  });

  it('maps every spec to the file manifest with raw invokes and visible-UI authorization', () => {
    const expectedChannels = new Set<string>(Object.values(DESKTOP_IPC_CHANNELS.files));
    const specs = [...Object.values(fileSystemContract), ...Object.values(fileSystemWatchContract)];
    for (const spec of specs) {
      expect(expectedChannels.has(spec.channel)).toBe(true);
      if (spec.kind === 'invoke') {
        expect(spec.envelope).toBe('raw');
        expect(spec.roles).toEqual(['visible-ui']);
      }
    }
    expect(fileSystemWatchContract.onWatchEvent.channel).toBe(
      DESKTOP_IPC_CHANNELS.files.watchEvent
    );
    expect(fileSystemWatchContract.onWatchHealth.channel).toBe(
      DESKTOP_IPC_CHANNELS.files.watchHealth
    );
  });

  it('parses exact argument tuples before handlers see renderer input', () => {
    expect(fileSystemContract.deleteRootData.parseArgs(['actual-root'])).toEqual(['actual-root']);
    expect(() => fileSystemContract.deleteRootData.parseArgs(['  '])).toThrow('durable root ID');
    expect(() => fileSystemContract.deleteRootData.parseArgs(['r'.repeat(1025)])).toThrow(
      'durable root ID'
    );
    expect(fileSystemContract.addRoot.parseArgs([])).toEqual([]);
    expect(fileSystemContract.readDirectory.parseArgs([directoryHandle])).toEqual([
      directoryHandle,
    ]);
    expect(
      fileSystemContract.readFileByAbsolutePath.parseArgs(['/workspace/a', '/workspace', 'r1'])
    ).toEqual(['/workspace/a', '/workspace', 'r1']);
    expect(fileSystemWatchContract.watchDirectory.parseArgs([directoryHandle])).toEqual([
      directoryHandle,
    ]);
    expect(fileSystemWatchContract.retryWatch.parseArgs(['watch-1'])).toEqual(['watch-1']);

    expect(() => fileSystemContract.addRoot.parseArgs(['extra'])).toThrow('exactly 0 arguments');
    expect(() => fileSystemContract.exists.parseArgs([42])).toThrow('requires a string');
    expect(() => fileSystemContract.readDirectory.parseArgs([{ path: 42 }])).toThrow(
      'handle path must be a string'
    );
    expect(() => fileSystemContract.readFileByAbsolutePath.parseArgs(['/a', '/root'])).toThrow(
      'exactly 3 arguments'
    );
    expect(() => fileSystemWatchContract.unwatchDirectory.parseArgs([null])).toThrow(
      'requires a string'
    );
  });
});
