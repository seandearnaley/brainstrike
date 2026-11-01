import type { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { fileSystemContract } from '../../ipc-domains/file-system.contract';
import { fileSystemArgs } from '../../ipc-domains/file-system-args';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import { ipcArgsDecoder } from '../../platform/ipc-args';

describe('file-system IPC contracts', () => {
  it('maps each transport envelope', () => {
    const expectedChannels = new Set<string>(Object.values(DESKTOP_IPC_CHANNELS.files));
    for (const spec of Object.values(fileSystemContract)) {
      expect(expectedChannels.has(spec.channel)).toBe(true);
      expect(spec.envelope).toBe('ipc-result');
    }
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
    expect(decode(fileSystemArgs.addRootByPath, ['/workspace'])).toEqual(['/workspace']);

    expect(() => decode(fileSystemArgs.addRoot, ['extra'])).toThrow('invalid arguments');
    expect(() => decode(fileSystemArgs.addRootByPath, [42])).toThrow('invalid arguments');
  });
});
