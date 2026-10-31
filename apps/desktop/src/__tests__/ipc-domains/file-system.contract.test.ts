import type { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  fileSystemContract,
  fileSystemWatchContract,
} from '../../ipc-domains/file-system.contract';
import { fileSystemArgs, fileSystemWatchArgs } from '../../ipc-domains/file-system-args';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import { ipcArgsDecoder } from '../../platform/ipc-args';

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

  it('maps each transport envelope', () => {
    const expectedChannels = new Set<string>(Object.values(DESKTOP_IPC_CHANNELS.files));
    const specs = [...Object.values(fileSystemContract), ...Object.values(fileSystemWatchContract)];
    for (const spec of specs) {
      expect(expectedChannels.has(spec.channel)).toBe(true);
      if (spec.kind === 'invoke') {
        expect(spec.envelope).toBe(
          Object.values(fileSystemContract).some((core) => core.channel === spec.channel)
            ? 'ipc-result'
            : 'raw'
        );
      }
    }
    expect(fileSystemWatchContract.onWatchEvent.channel).toBe(
      DESKTOP_IPC_CHANNELS.files.watchEvent
    );
    expect(fileSystemWatchContract.onWatchHealth.channel).toBe(
      DESKTOP_IPC_CHANNELS.files.watchHealth
    );
  });

  it('decodes exact argument tuples before handlers see renderer input', () => {
    const decode = <Args extends readonly unknown[]>(
      schema: Schema.Decoder<Args>,
      raw: readonly unknown[]
    ) => ipcArgsDecoder('file-system', schema)(raw);
    expect(decode(fileSystemArgs.deleteRootData, ['actual-root'])).toEqual(['actual-root']);
    expect(() => decode(fileSystemArgs.deleteRootData, ['  '])).toThrow('durable root ID');
    expect(() => decode(fileSystemArgs.deleteRootData, ['r'.repeat(1025)])).toThrow(
      'durable root ID'
    );
    expect(decode(fileSystemArgs.readDirectory, [directoryHandle])).toEqual([directoryHandle]);
    expect(ipcArgsDecoder('watch', fileSystemWatchArgs.watchDirectory)([directoryHandle])).toEqual([
      directoryHandle,
    ]);

    expect(() => decode(fileSystemArgs.addRoot, ['extra'])).toThrow('invalid arguments');
    expect(() => decode(fileSystemArgs.readDirectory, [{ ...directoryHandle, path: 42 }])).toThrow(
      'invalid arguments'
    );
    expect(() => decode(fileSystemArgs.readFile, [directoryHandle])).toThrow('invalid arguments');
    expect(() => decode(fileSystemArgs.readFileByAbsolutePath, ['/a', '/root'])).toThrow(
      'invalid arguments'
    );
  });
});
