/**
 * Per-root source dispatch for the metadata seam (BST-1208).
 *
 * The CARRIED contract from the BST-1207 review lives here: a directory the
 * registry cannot enumerate must read as an explicit incomplete subtree, never
 * `null` — `computeDirectoryRollup` throws on null, which would take down the
 * render of a lazily expanded row.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { describe, expect, it } from 'vitest';
import {
  createFileRowMetadataSourceRegistry,
  type FileRowMetadataSource,
} from '../indexing/file-row-metadata-source-registry';

const ROOT_A = 'root-a';
const ROOT_B = 'root-b';

function stubSource(overrides: Partial<FileRowMetadataSource> = {}): FileRowMetadataSource {
  return {
    getDirectorySubtree: () => ({ fileKeys: [], isComplete: true }),
    getNodeSize: () => undefined,
    ...overrides,
  };
}

describe('file row metadata source registry', () => {
  it('dispatches to the source that owns the key’s root', () => {
    const registry = createFileRowMetadataSourceRegistry();
    registry.register(ROOT_A, stubSource({ getNodeSize: () => 10 }));
    registry.register(ROOT_B, stubSource({ getNodeSize: () => 20 }));

    expect(registry.getNodeSize(encodeFileSelection(ROOT_A, 'src/a.ts'))).toBe(10);
    expect(registry.getNodeSize(encodeFileSelection(ROOT_B, 'src/a.ts'))).toBe(20);
  });

  it('passes the PATH half of the key to the source', () => {
    const registry = createFileRowMetadataSourceRegistry();
    const seen: string[] = [];
    registry.register(
      ROOT_A,
      stubSource({
        getNodeSize: (path) => {
          seen.push(path);
          return;
        },
      })
    );

    registry.getNodeSize(encodeFileSelection(ROOT_A, 'src/nested/a.ts'));
    expect(seen).toEqual(['src/nested/a.ts']);
  });

  it('reports an INCOMPLETE subtree — never null — for an unregistered root', () => {
    const registry = createFileRowMetadataSourceRegistry();
    expect(registry.getDirectorySubtree(encodeFileSelection(ROOT_A, 'src'))).toEqual({
      fileKeys: [],
      isComplete: false,
    });
  });

  it('reports an INCOMPLETE subtree for a malformed key instead of throwing', () => {
    const registry = createFileRowMetadataSourceRegistry();
    expect(registry.getDirectorySubtree('not-a-composite-key')).toEqual({
      fileKeys: [],
      isComplete: false,
    });
    expect(registry.getNodeSize('not-a-composite-key')).toBeUndefined();
  });

  it('unregisters only its own source, so a remount-before-cleanup keeps the root sourced', () => {
    const registry = createFileRowMetadataSourceRegistry();
    const first = stubSource({ getNodeSize: () => 1 });
    const second = stubSource({ getNodeSize: () => 2 });
    const unregisterFirst = registry.register(ROOT_A, first);
    registry.register(ROOT_A, second);

    unregisterFirst();

    expect(registry.getNodeSize(encodeFileSelection(ROOT_A, 'a.ts'))).toBe(2);
  });
});
