/**
 * Three-path ordering parity for Explorer per-directory sorting (BST-1209).
 *
 * OptimizedFileTree can project rows from the normalized desktop maps, worker-
 * flattened nodes, or the renderer DFS fallback. A sort change must produce
 * one identical DFS order whichever source built the rows.
 */
import type { FlattenedNode, WorkerFileNode } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  type BuildFileTreeRowsOptions,
  buildFileTreeRows,
  buildRowsFromNormalizedTree,
  buildRowsFromWorkerNodes,
  compareFileTreeSiblings,
  createFileTreeRowReuseCache,
  indexFileNodesByPath,
} from '../tree/optimized-file-tree-model';
import {
  createNormalizedFileTreeState,
  getNormalizedDescendantFileCount,
} from '../utils/normalized-file-tree';
import { toWorkerFileNodes } from '../utils/worker-node-conversion';

interface SortMetadata {
  size: number | 'excluded' | 'pending';
  tokens: number | 'excluded' | 'pending';
  type: string;
}

const ROOT = 'root';

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

function directory(path: string, children: IFileNode[]): IFileNode {
  return {
    children,
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    loadState: 'loaded',
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
  };
}

function flattenWorkerNodes(nodes: readonly WorkerFileNode[], depth = 0): FlattenedNode[] {
  const flattened: FlattenedNode[] = [];
  for (const node of nodes) {
    flattened.push({ depth, node });
    if (node.children) {
      flattened.push(...flattenWorkerNodes(node.children, depth + 1));
    }
  }
  return flattened;
}

describe('Explorer per-directory sort parity', () => {
  it('orders normalized, worker, and main-thread rows identically', () => {
    const tree = [
      directory('/root/z-dir', [
        file('/root/z-dir/pending.ts'),
        file('/root/z-dir/five-b.ts'),
        file('/root/z-dir/five-a.ts'),
      ]),
      file('/root/pending.ts'),
      directory('/root/a-dir', [file('/root/a-dir/two.ts')]),
      file('/root/twenty.ts'),
      file('/root/five.ts'),
      file('/root/excluded.bin'),
    ];
    const metadata = new Map<string, SortMetadata>([
      ['/root/a-dir', { size: 20, tokens: 2, type: '' }],
      ['/root/a-dir/two.ts', { size: 20, tokens: 2, type: 'ts' }],
      ['/root/excluded.bin', { size: 30, tokens: 'excluded', type: 'bin' }],
      ['/root/five.ts', { size: 50, tokens: 5, type: 'ts' }],
      ['/root/pending.ts', { size: 'pending', tokens: 'pending', type: 'ts' }],
      ['/root/twenty.ts', { size: 200, tokens: 20, type: 'ts' }],
      ['/root/z-dir', { size: 100, tokens: 9, type: '' }],
      ['/root/z-dir/five-a.ts', { size: 10, tokens: 5, type: 'ts' }],
      ['/root/z-dir/five-b.ts', { size: 10, tokens: 5, type: 'ts' }],
      ['/root/z-dir/pending.ts', { size: 'pending', tokens: 'pending', type: 'ts' }],
    ]);
    const options = {
      expandedDirectoryPaths: new Set(['/root/a-dir', '/root/z-dir']),
      folderId: 'root',
      loadingFiles: new Set<string>(),
      sort: {
        getMetadata: (node: IFileNode): SortMetadata => {
          const snapshot = metadata.get(node.path);
          if (!snapshot) {
            throw new Error(`Missing sort metadata for ${node.path}`);
          }
          return snapshot;
        },
        state: { direction: 'asc' as const, field: 'tokens' as const },
      },
    } satisfies BuildFileTreeRowsOptions;
    const normalizedTree = createNormalizedFileTreeState(tree);
    const lookup = new Map<string, IFileNode>();
    indexFileNodesByPath(tree, lookup);
    const workerNodes = flattenWorkerNodes(toWorkerFileNodes(tree));

    const outputs = [
      buildRowsFromNormalizedTree(
        normalizedTree,
        options,
        (path) => getNormalizedDescendantFileCount(normalizedTree, path),
        null
      ),
      buildRowsFromWorkerNodes(workerNodes, (path) => lookup.get(path), options),
      buildFileTreeRows(tree, options),
    ].map((rows) => rows.map((row) => row.id));

    expect(new Set(outputs.map((output) => JSON.stringify(output))).size).toBe(1);
    expect(outputs[0]).toEqual([
      '/root/a-dir',
      '/root/a-dir/two.ts',
      '/root/z-dir',
      '/root/z-dir/five-a.ts',
      '/root/z-dir/five-b.ts',
      '/root/z-dir/pending.ts',
      '/root/five.ts',
      '/root/twenty.ts',
      '/root/excluded.bin',
      '/root/pending.ts',
    ]);
  });

  it('keeps absent numeric metadata last in descending order', () => {
    const one = file('/root/one.ts');
    const ten = file('/root/ten.ts');
    const pending = file('/root/pending.ts');
    const values = new Map([
      [one.path, 1],
      [ten.path, 10],
    ]);
    const rows = buildFileTreeRows([one, pending, ten], {
      expandedDirectoryPaths: new Set(),
      folderId: ROOT,
      loadingFiles: new Set(),
      sort: {
        getMetadata: (node) => ({
          size: 'pending',
          tokens: values.get(node.path) ?? 'pending',
          type: 'ts',
        }),
        state: { direction: 'desc', field: 'tokens' },
      },
    });

    expect(rows.map((row) => row.id)).toEqual([ten.path, one.path, pending.path]);
  });

  it('sorts extensions locale-aware and preserves directories-first', () => {
    const folder = directory('/root/z-folder', []);
    const markdown = file('/root/a.md');
    const typescript = file('/root/z.ts');
    const metadataFor = (node: IFileNode): SortMetadata => ({
      size: 1,
      tokens: 1,
      type: node.path.endsWith('.md') ? 'md' : node.path.endsWith('.ts') ? 'ts' : '',
    });

    expect(
      [typescript, markdown, folder]
        .sort((a, b) =>
          compareFileTreeSiblings(a, b, {
            getMetadata: metadataFor,
            state: { direction: 'asc', field: 'type' },
          })
        )
        .map((node) => node.path)
    ).toEqual([folder.path, markdown.path, typescript.path]);
  });

  it('reuses untouched row objects when a sort change preserves their subtree order', () => {
    const firstDirectory = directory('/root/a-dir', [
      file('/root/a-dir/a.ts'),
      file('/root/a-dir/b.ts'),
    ]);
    const secondDirectory = directory('/root/z-dir', [file('/root/z-dir/c.ts')]);
    const tree = [firstDirectory, secondDirectory];
    const cache = createFileTreeRowReuseCache();
    const common = {
      expandedDirectoryPaths: new Set([firstDirectory.path, secondDirectory.path]),
      folderId: 'root',
      loadingFiles: new Set<string>(),
    };
    const first = cache.stabilize(
      buildFileTreeRows(tree, {
        ...common,
        sort: {
          getMetadata: () => ({ size: 1, tokens: 1, type: '' }),
          state: { direction: 'asc', field: 'name' },
        },
      })
    );
    const second = cache.stabilize(
      buildFileTreeRows(tree, {
        ...common,
        sort: {
          getMetadata: (node) => ({
            size: 1,
            tokens: node.path === secondDirectory.path ? 2 : 1,
            type: '',
          }),
          state: { direction: 'desc', field: 'tokens' },
        },
      })
    );

    expect(second.map((row) => row.id)).toEqual([
      secondDirectory.path,
      '/root/z-dir/c.ts',
      firstDirectory.path,
      '/root/a-dir/a.ts',
      '/root/a-dir/b.ts',
    ]);
    const firstById = new Map(first.map((row) => [row.id, row]));
    for (const row of second) {
      expect(row).toBe(firstById.get(row.id));
    }
  });
});
