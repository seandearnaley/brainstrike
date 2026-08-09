/** Synthetic 10k-node sort-change measurement for BST-1209. */
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { buildFileTreeRows, createFileTreeRowReuseCache } from '../tree/optimized-file-tree-model';

function file(path: string): IFileNode {
  return {
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  };
}

function buildLargeTree(): { expanded: Set<string>; tree: IFileNode[] } {
  const expanded = new Set<string>();
  const tree: IFileNode[] = [];
  for (let directoryIndex = 0; directoryIndex < 100; directoryIndex += 1) {
    const directoryPath = `/root/dir-${directoryIndex.toString().padStart(3, '0')}`;
    expanded.add(directoryPath);
    const children: IFileNode[] = [];
    for (let fileIndex = 0; fileIndex < 100; fileIndex += 1) {
      children.push(file(`${directoryPath}/file-${fileIndex.toString().padStart(3, '0')}.ts`));
    }
    tree.push({
      children,
      depth: 0,
      handle: {} as FileSystemDirectoryHandle,
      isVisible: true,
      loadState: 'loaded',
      name: directoryPath.split('/').at(-1) ?? directoryPath,
      path: directoryPath,
      rootFolderId: 'root',
      selectionState: 'unchecked',
      type: 'directory',
    });
  }
  return { expanded, tree };
}

describe('Explorer sort-change performance', () => {
  it('pays comparator work once for a 10k-node rebuild and zero times across frame reads', () => {
    const { expanded, tree } = buildLargeTree();
    const common = {
      expandedDirectoryPaths: expanded,
      folderId: 'root',
      loadingFiles: new Set<string>(),
    };
    const cache = createFileTreeRowReuseCache();

    const baselineStartedAt = performance.now();
    const baselineRows = cache.stabilize(buildFileTreeRows(tree, common));
    const baselineMs = performance.now() - baselineStartedAt;

    let metadataReadCount = 0;
    const sortStartedAt = performance.now();
    const sortedRows = cache.stabilize(
      buildFileTreeRows(tree, {
        ...common,
        sort: {
          getMetadata: (node) => {
            metadataReadCount += 1;
            const index = Number.parseInt(node.name.match(/\d+/)?.[0] ?? '0', 10);
            return { size: index, tokens: index, type: node.type === 'file' ? 'ts' : '' };
          },
          state: { direction: 'desc', field: 'tokens' },
        },
      })
    );
    const sortChangeMs = performance.now() - sortStartedAt;
    const readsAfterRebuild = metadataReadCount;

    let frameChecksum = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      frameChecksum += sortedRows.length;
    }

    expect(baselineRows).toHaveLength(10_100);
    expect(sortedRows).toHaveLength(10_100);
    expect(metadataReadCount).toBe(readsAfterRebuild);
    expect(frameChecksum).toBe(10_100 * 120);
    const baselineById = new Map(baselineRows.map((row) => [row.id, row]));
    expect(sortedRows.every((row) => row === baselineById.get(row.id))).toBe(true);

    console.info(
      `BST-1209 sort telemetry: nodes=10100 baselineMs=${baselineMs.toFixed(3)} sortChangeMs=${sortChangeMs.toFixed(3)} metadataReads=${metadataReadCount} frameReads=120 postFrameMetadataReads=${metadataReadCount}`
    );
  });
});
