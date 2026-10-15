// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  type DroppableFolderItem,
  extractDroppedFolderPaths,
} from '../workspace-connect/extract-dropped-folder-paths';

function directoryItem(path: string): DroppableFolderItem {
  let settled = false;
  queueMicrotask(() => {
    settled = true;
  });
  const file = { name: path.split('/').at(-1) ?? path } as unknown as File;
  return {
    getAsFile: () => {
      if (settled) {
        throw new Error('DataTransferItem accessed after the drop event settled');
      }
      return file;
    },
    kind: 'file',
    webkitGetAsEntry: () => {
      if (settled) {
        throw new Error('DataTransferItem accessed after the drop event settled');
      }
      return { isDirectory: true };
    },
  };
}

function plainFileItem(): DroppableFolderItem {
  return {
    getAsFile: () => ({ name: 'notes.md' }) as unknown as File,
    kind: 'file',
    webkitGetAsEntry: () => ({ isDirectory: false }),
  };
}

describe('extractDroppedFolderPaths', () => {
  it('resolves every dropped directory inside the drop tick', () => {
    const resolvePath = vi.fn((file: File) => `/w/${file.name}`);
    expect(
      extractDroppedFolderPaths([directoryItem('/w/alpha'), directoryItem('/w/beta')], resolvePath)
    ).toEqual({
      paths: ['/w/alpha', '/w/beta'],
      skippedFileCount: 0,
      unreadableCount: 0,
      unresolvedCount: 0,
    });
    expect(resolvePath).toHaveBeenCalledTimes(2);
  });

  it('COUNTS plain files instead of forwarding them', () => {
    // Ruling D1's falsifier: a blind-send implementation would hand a FILE to
    // fs:addRootByPath, which refuses it with a message about GRANTS —
    // describing the wrong problem entirely.
    const resolvePath = vi.fn(() => '/w/notes.md');
    expect(extractDroppedFolderPaths([plainFileItem()], resolvePath)).toEqual({
      paths: [],
      skippedFileCount: 1,
      unreadableCount: 0,
      unresolvedCount: 0,
    });
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it('counts a directory whose File is not disk-backed rather than dropping it silently', () => {
    expect(extractDroppedFolderPaths([directoryItem('/w/alpha')], () => '')).toEqual({
      paths: [],
      skippedFileCount: 0,
      unreadableCount: 0,
      unresolvedCount: 1,
    });
  });

  it('ignores non-file items (a dragged text selection)', () => {
    expect(
      extractDroppedFolderPaths(
        [{ getAsFile: () => null, kind: 'string', webkitGetAsEntry: () => null }],
        vi.fn()
      )
    ).toEqual({ paths: [], skippedFileCount: 0, unreadableCount: 0, unresolvedCount: 0 });
  });

  it('counts an item whose entry cannot be read as UNREADABLE, not unresolved — its kind is unknown', () => {
    // Review finding: folding this into unresolvedCount tells the user
    // "N folders could not be read" about an item never confirmed to BE a
    // folder — the same wrong-noun mistake ruling D1 exists to prevent.
    const throwing: DroppableFolderItem = {
      getAsFile: () => null,
      kind: 'file',
      webkitGetAsEntry: () => {
        throw new Error('no entry');
      },
    };
    expect(
      extractDroppedFolderPaths([throwing, directoryItem('/w/alpha')], (file) => `/w/${file.name}`)
    ).toEqual({
      paths: ['/w/alpha'],
      skippedFileCount: 0,
      unreadableCount: 1,
      unresolvedCount: 0,
    });
  });

  it('dedupes a folder dropped twice in one gesture', () => {
    expect(
      extractDroppedFolderPaths(
        [directoryItem('/w/alpha'), directoryItem('/w/alpha')],
        () => '/w/alpha'
      )
    ).toEqual({
      paths: ['/w/alpha'],
      skippedFileCount: 0,
      unreadableCount: 0,
      unresolvedCount: 0,
    });
  });
});
