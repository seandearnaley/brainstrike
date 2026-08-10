/**
 * Synthetic 10k-node sort-change measurement for BST-1209.
 *
 * The comparator runs against the REAL metadata seam — a real
 * `createFileRowMetadataStore`, real composite-key encoding, real directory
 * rollups — using the same `getMetadata` closure `OptimizedFileTree` builds.
 * An earlier version of this test regexed the node NAME, which measured a
 * synthetic comparator and hid the seam entirely: production allocates a
 * composite key and does a store lookup per read, and reading inside the
 * comparator meant ~130k of those at 10k rows (BST-1209 review, important
 * finding 3). The seam has to be in the measurement or the number is fiction.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { UNENUMERATED_DIRECTORY_SUBTREE } from '../indexing/file-row-metadata-source-registry';
import {
  createFileRowMetadataStore,
  type FileRowDirectorySubtree,
} from '../indexing/file-row-metadata-store';
import { createFileTreeSortMetadataReader } from '../tree/file-tree-sort-metadata';
import { buildFileTreeRows, createFileTreeRowReuseCache } from '../tree/optimized-file-tree-model';

const FOLDER = 'root';
const DIRECTORY_COUNT = 100;
const FILES_PER_DIRECTORY = 100;
const TOTAL_ROWS = DIRECTORY_COUNT * (FILES_PER_DIRECTORY + 1);

function file(path: string): IFileNode {
  return {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: FOLDER,
    selectionState: 'unchecked',
    type: 'file',
  };
}

interface LargeTreeFixture {
  expanded: Set<string>;
  sizeByKey: Map<string, number>;
  subtreeByKey: Map<string, FileRowDirectorySubtree>;
  tokensByKey: Map<string, number>;
  tree: IFileNode[];
}

function buildLargeTree(): LargeTreeFixture {
  const expanded = new Set<string>();
  const tree: IFileNode[] = [];
  const sizeByKey = new Map<string, number>();
  const tokensByKey = new Map<string, number>();
  const subtreeByKey = new Map<string, FileRowDirectorySubtree>();

  for (let directoryIndex = 0; directoryIndex < DIRECTORY_COUNT; directoryIndex += 1) {
    const directoryPath = `/root/dir-${directoryIndex.toString().padStart(3, '0')}`;
    expanded.add(directoryPath);
    const children: IFileNode[] = [];
    const fileKeys: string[] = [];
    for (let fileIndex = 0; fileIndex < FILES_PER_DIRECTORY; fileIndex += 1) {
      const path = `${directoryPath}/file-${fileIndex.toString().padStart(3, '0')}.ts`;
      const compositeKey = encodeFileSelection(FOLDER, path);
      children.push(file(path));
      fileKeys.push(compositeKey);
      sizeByKey.set(compositeKey, fileIndex * 13);
      tokensByKey.set(compositeKey, fileIndex * 7);
    }
    subtreeByKey.set(encodeFileSelection(FOLDER, directoryPath), { fileKeys, isComplete: true });
    tree.push({
      children,
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'loaded',
      name: directoryPath.split('/').at(-1) ?? directoryPath,
      path: directoryPath,
      rootFolderId: FOLDER,
      selectionState: 'unchecked',
      type: 'directory',
    });
  }

  return { expanded, sizeByKey, subtreeByKey, tokensByKey, tree };
}

describe('Explorer sort-change performance', () => {
  it('pays comparator work once for a 10k-node rebuild and zero times across frame reads', () => {
    const { expanded, sizeByKey, subtreeByKey, tokensByKey, tree } = buildLargeTree();
    const store = createFileRowMetadataStore({
      getCachedSize: () => undefined,
      getDirectorySubtree: (compositeKey) =>
        subtreeByKey.get(compositeKey) ?? UNENUMERATED_DIRECTORY_SUBTREE,
      getNodeSize: (compositeKey) => sizeByKey.get(compositeKey),
      getTokenCount: (compositeKey) => tokensByKey.get(compositeKey),
    });

    const getDirectorySnapshot = vi.spyOn(store, 'getDirectorySnapshot');
    const peekSnapshot = vi.spyOn(store, 'peekSnapshot');
    const getMetadata = createFileTreeSortMetadataReader(FOLDER, store);

    const common = {
      expandedDirectoryPaths: expanded,
      folderId: FOLDER,
      loadingFiles: new Set<string>(),
    };
    const cache = createFileTreeRowReuseCache();

    const baselineStartedAt = performance.now();
    const baselineRows = cache.stabilize(buildFileTreeRows(tree, common));
    const baselineMs = performance.now() - baselineStartedAt;

    const sortStartedAt = performance.now();
    const sortedRows = cache.stabilize(
      buildFileTreeRows(tree, {
        ...common,
        sort: { getMetadata, state: { direction: 'desc', field: 'tokens' } },
      })
    );
    const sortChangeMs = performance.now() - sortStartedAt;
    const readsAfterRebuild =
      getDirectorySnapshot.mock.calls.length + peekSnapshot.mock.calls.length;

    let frameChecksum = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      frameChecksum += sortedRows.length;
    }

    expect(baselineRows).toHaveLength(TOTAL_ROWS);
    expect(sortedRows).toHaveLength(TOTAL_ROWS);
    // Schwartzian: ONE seam read per row. Reading inside the comparator instead
    // costs 2 per comparison — an order of magnitude more at this size.
    expect(readsAfterRebuild).toBe(TOTAL_ROWS);
    expect(getDirectorySnapshot.mock.calls.length + peekSnapshot.mock.calls.length).toBe(
      readsAfterRebuild
    );
    expect(frameChecksum).toBe(TOTAL_ROWS * 120);
    const baselineById = new Map(baselineRows.map((row) => [row.id, row]));
    expect(sortedRows.every((row) => row === baselineById.get(row.id))).toBe(true);

    console.info(
      `BST-1209 sort telemetry: nodes=${TOTAL_ROWS} baselineMs=${baselineMs.toFixed(3)} sortChangeMs=${sortChangeMs.toFixed(3)} metadataReads=${readsAfterRebuild} frameReads=120 postFrameMetadataReads=${readsAfterRebuild}`
    );
  });
});
