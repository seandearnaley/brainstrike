import { describe, expect, it } from 'vitest';
import { fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { type DroppableItem, extractDroppedVaultDirectories } from '../drop';

function directoryItem(dir: ReturnType<typeof fakeDir>): DroppableItem {
  let invalidated = false;
  // getAsFileSystemHandle must be called in the same tick as the drop event;
  // simulate the browser invalidating the DataTransferItem after a microtask.
  void Promise.resolve().then(() => {
    invalidated = true;
  });
  return {
    getAsFileSystemHandle: () => {
      if (invalidated) {
        throw new Error('DataTransferItem accessed after the drop event settled');
      }
      return Promise.resolve(dir);
    },
    kind: 'file',
  };
}

function fileItem(note: ReturnType<typeof fakeNote>): DroppableItem {
  return { getAsFileSystemHandle: () => Promise.resolve(note), kind: 'file' };
}

describe('extractDroppedVaultDirectories', () => {
  it('collects every handle synchronously before awaiting (drop-tick contract)', async () => {
    const first = fakeDir('vault-a');
    const second = fakeDir('vault-b');

    const result = await extractDroppedVaultDirectories([
      directoryItem(first),
      directoryItem(second),
    ]);

    expect(result.directories).toEqual([first, second]);
    expect(result.skippedFileCount).toBe(0);
  });

  it('counts dropped plain files as skipped instead of failing', async () => {
    const result = await extractDroppedVaultDirectories([
      fileItem(fakeNote('loose.md')),
      directoryItem(fakeDir('vault')),
    ]);

    expect(result.directories.map((dir) => dir.name)).toEqual(['vault']);
    expect(result.skippedFileCount).toBe(1);
  });

  it('ignores non-file items (e.g. dragged text) and null handles', async () => {
    const result = await extractDroppedVaultDirectories([
      { getAsFileSystemHandle: () => Promise.resolve(null), kind: 'file' },
      { kind: 'string' },
    ]);

    expect(result.directories).toEqual([]);
    expect(result.skippedFileCount).toBe(0);
  });

  it('reports the capability as unsupported when items lack getAsFileSystemHandle', async () => {
    const result = await extractDroppedVaultDirectories([{ kind: 'file' }]);

    expect(result.unsupported).toBe(true);
    expect(result.directories).toEqual([]);
  });
});
