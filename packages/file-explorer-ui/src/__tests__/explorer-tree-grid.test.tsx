/**
 * The Explorer as a tree GRID (BST-1208).
 *
 * Covers the four columns end to end — the real `OptimizedFileTree`, the real
 * metadata seam, the real cells — and the three things that must not regress:
 *
 * 1. Explicit non-values. `pending` is never `0`, `excluded` carries the binary
 *    tooltip, and a partial folder rollup never renders a number.
 * 2. The CARRIED contract: a directory whose subtree is not enumerated renders
 *    a partial marker instead of throwing mid-render.
 * 3. The performance contract: a token arriving repaints ONE cell. Sibling
 *    rows are not re-read, and no row rebuild happens at all.
 */

import { useExplorerSortStateStore } from '@brainstrike/app-state/stores/explorer-sort-state-store';
import { createLogger } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ExplorerRowMetadata,
  useExplorerRowMetadata,
} from '../indexing/file-row-metadata-context';
import { FileRowMetadataProvider } from '../indexing/file-row-metadata-provider';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import { ExplorerColumnsProvider } from '../shell/explorer-columns-provider';
import { ExplorerSortProvider } from '../shell/explorer-sort-provider';
import { EXCLUDED_TOKENS_TITLE } from '../tree/file-tree-metadata-cells';
import { resetReportedUnidentifiedRowsForTests } from '../tree/file-tree-metadata-diagnostics';
import { fileTreeTelemetry } from '../tree/file-tree-telemetry-counters';
import OptimizedFileTree from '../tree/optimized-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

const ROOT = 'root';

interface StubCacheState {
  isOperational: boolean;
  tokens: Record<string, number>;
}

let cacheState: StubCacheState;

vi.mock('../indexing/token-cache-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../indexing/token-cache-context')>();
  return {
    ...actual,
    useOptionalTokenCacheContext: (): TokenCacheContextValue =>
      ({
        cacheVersion: 1,
        getFileSize: () => undefined,
        getTokenCount: (_folderId: string, path: string) => cacheState.tokens[path] ?? null,
        isOperational: cacheState.isOperational,
      }) as unknown as TokenCacheContextValue,
  };
});

function file(path: string, size?: number): IFileNode {
  return {
    depth: 1,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: ROOT,
    selectionState: 'unchecked',
    ...(size === undefined ? {} : { size }),
    type: 'file',
  };
}

function directory(path: string, children: IFileNode[], isLoaded: boolean): IFileNode {
  return {
    children,
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    ...(isLoaded ? { loadState: 'loaded' as const } : {}),
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: ROOT,
    selectionState: 'unchecked',
    type: 'directory',
  };
}

const LOADED_TREE: IFileNode[] = [
  directory('/src', [file('/src/a.ts', 100), file('/src/b.ts', 20)], true),
  file('/notes.txt', 42),
  file('/logo.png', 900),
];

const UNENUMERATED_TREE: IFileNode[] = [directory('/lazy', [], false)];

function Harness({
  fileTree,
  folderId = ROOT,
  onReady,
}: {
  fileTree: IFileNode[];
  folderId?: string;
  onReady?: ((metadata: ExplorerRowMetadata) => void) | undefined;
}) {
  const rowMetadata = useExplorerRowMetadata();
  useEffect(() => {
    onReady?.(rowMetadata);
  }, [onReady, rowMetadata]);
  return (
    <ExplorerSortProvider>
      <FileRowMetadataProvider value={rowMetadata.contextValue}>
        <ExplorerColumnsProvider
          value={{
            areMetadataColumnsSuppressed: false,
            // Wide enough that clamping is a no-op; the clamp itself is pinned in
            // explorer-column-header.test.tsx.
            columnWidths: { size: 76, tokens: 76, type: 72 },
            visibleMetadataColumnIds: ['type', 'tokens', 'size'],
          }}
        >
          <OptimizedFileTree
            fileTree={fileTree}
            folderId={folderId}
            loadingFiles={new Set()}
            showColumnHeader={true}
          />
        </ExplorerColumnsProvider>
      </FileRowMetadataProvider>
    </ExplorerSortProvider>
  );
}

/**
 * Directory rollups are deferred off the first paint (review item 2), so they
 * land one task later. Every test except the deliberate first-paint one wants
 * the settled grid.
 */
async function settleDeferredRollups(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

async function renderGrid(
  fileTree: IFileNode[],
  onReady?: (metadata: ExplorerRowMetadata) => void
): Promise<void> {
  await act(async () => {
    render(
      <FileExplorerTestWrapper>
        <Harness fileTree={fileTree} onReady={onReady} />
      </FileExplorerTestWrapper>
    );
  });
  await settleDeferredRollups();
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByRole('row', { name: new RegExp(`Select ${name}\\b`) });
  return row;
}

describe('Explorer tree grid', () => {
  beforeEach(() => {
    cacheState = { isOperational: true, tokens: {} };
    resetReportedUnidentifiedRowsForTests();
    useExplorerSortStateStore.getState().reset();
  });

  it('renders the four column headers when the single-root header is enabled', async () => {
    await renderGrid(LOADED_TREE);
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Name', 'Type', 'Tokens', 'Size']);
  });

  it('routes the single-root header through TreeTable sorting state', async () => {
    await renderGrid(LOADED_TREE);
    const tokensHeader = screen.getByRole('columnheader', { name: /^Tokens/ });

    fireEvent.click(tokensHeader);
    expect(useExplorerSortStateStore.getState().sortState).toEqual({
      direction: 'asc',
      field: 'tokens',
    });
    expect(tokensHeader).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(tokensHeader);
    expect(useExplorerSortStateStore.getState().sortState).toEqual({
      direction: 'desc',
      field: 'tokens',
    });
    expect(tokensHeader).toHaveAttribute('aria-sort', 'descending');

    fireEvent.click(tokensHeader);
    expect(useExplorerSortStateStore.getState().sortState).toBeNull();
  });

  it('shows a real count and size for a counted file', async () => {
    cacheState.tokens['/notes.txt'] = 1234;
    await renderGrid(LOADED_TREE);

    const row = rowFor('notes.txt');
    expect(within(row).getByTitle('1,234 tokens')).toHaveTextContent('1.2K');
    expect(within(row).getByTitle('42 bytes')).toBeInTheDocument();
    expect(within(row).getByText('txt')).toBeInTheDocument();
  });

  it('renders an uncounted file as a pending placeholder — never 0', async () => {
    await renderGrid(LOADED_TREE);

    const row = rowFor('notes.txt');
    const pending = within(row).getByTitle('Token count pending');
    expect(pending).toBeInTheDocument();
    // The placeholder carries no digits at all: a "0" here would be a count.
    expect(pending.textContent).not.toMatch(/\d/);
  });

  it('renders a binary file as excluded with the binary tooltip', async () => {
    await renderGrid(LOADED_TREE);

    const row = rowFor('logo.png');
    expect(within(row).getByTitle(EXCLUDED_TOKENS_TITLE)).toBeInTheDocument();
    expect(within(row).queryByTitle('Token count pending')).not.toBeInTheDocument();
  });

  it('renders malformed row metadata as unavailable and reports the row only once', async () => {
    const error = vi
      .spyOn(createLogger('FileTreeMetadataCells'), 'error')
      .mockImplementation(() => {});
    const unidentified = file('/unidentified.ts', 42);
    unidentified.rootFolderId = '';

    await act(async () => {
      render(
        <FileExplorerTestWrapper>
          <Harness fileTree={[unidentified]} folderId="" />
        </FileExplorerTestWrapper>
      );
    });

    const row = rowFor('unidentified.ts');
    expect(
      within(row).getAllByTitle('Metadata unavailable — this row has no workspace identity')
    ).toHaveLength(2);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('rolls a fully counted, fully loaded folder up to a total', async () => {
    cacheState.tokens['/src/a.ts'] = 10;
    cacheState.tokens['/src/b.ts'] = 5;
    await renderGrid(LOADED_TREE);

    const row = rowFor('src');
    expect(within(row).getByTitle('Folder total: 15 tokens')).toHaveTextContent('15');
    expect(within(row).getByTitle('Folder total: 120 bytes')).toBeInTheDocument();
  });

  it('renders a folder whose files are still being counted as visibly partial', async () => {
    cacheState.tokens['/src/a.ts'] = 10;
    await renderGrid(LOADED_TREE);

    // Both metadata columns go partial together: a half-counted subtree has no
    // trustworthy token total AND no trustworthy byte total.
    expect(
      within(rowFor('src')).getAllByTitle(
        'Folder total unavailable — some files are still being counted'
      )
    ).toHaveLength(2);
  });

  /**
   * CARRIED contract from the BST-1207 review: `computeDirectoryRollup` throws
   * on a null subtree by design, so the tree's source must answer an
   * unenumerated directory with an explicit incomplete marker. Getting this
   * wrong takes down the render of any lazily expanded row.
   */
  it('renders an unenumerated directory as partial instead of throwing', async () => {
    await renderGrid(UNENUMERATED_TREE);

    expect(
      within(rowFor('lazy')).getAllByTitle(
        'Folder total unavailable — this folder is not fully enumerated'
      )
    ).toHaveLength(2);
  });

  /**
   * Review item 2: the measured worst case for a viewport of capped directory
   * rows is 21-29ms of synchronous aggregation
   * (`explorer-directory-rollup-cost.test.ts`), so the first paint must not pay
   * it. The folder shows the honest "not enumerated yet" marker, and the total
   * arrives once the deferred batch resolves.
   */
  it('keeps folder aggregation OFF the first paint, then fills it in', () => {
    cacheState.tokens['/src/a.ts'] = 10;
    cacheState.tokens['/src/b.ts'] = 5;
    // Fake timers, because `await act(async …)` yields to the macrotask queue
    // and would let the deferred flush run before the assertion — the first
    // paint has to be observed deterministically.
    vi.useFakeTimers();
    try {
      act(() => {
        render(
          <FileExplorerTestWrapper>
            <Harness fileTree={LOADED_TREE} />
          </FileExplorerTestWrapper>
        );
      });

      expect(
        within(rowFor('src')).getAllByTitle(
          'Folder total recomputing — this folder is still being enumerated'
        ).length
      ).toBeGreaterThan(0);

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(within(rowFor('src')).getByTitle('Folder total: 15 tokens')).toHaveTextContent('15');
    } finally {
      vi.useRealTimers();
    }
  });

  it('repaints ONLY the affected row when a token count arrives', async () => {
    let metadata: ExplorerRowMetadata | null = null;
    await renderGrid(LOADED_TREE, (value) => {
      metadata = value;
    });
    const ready = metadata as ExplorerRowMetadata | null;
    if (!ready) {
      throw new Error('expected the harness to expose the metadata seam');
    }

    // useSyncExternalStore re-reads a cell's snapshot exactly when that cell
    // re-renders, so the keys passed to getSnapshot name the repainted cells.
    const readKeys: string[] = [];
    const originalGetSnapshot = ready.contextValue.store.getSnapshot;
    vi.spyOn(ready.contextValue.store, 'getSnapshot').mockImplementation((compositeKey) => {
      readKeys.push(compositeKey);
      return originalGetSnapshot(compositeKey);
    });
    const rowBuildsBefore = fileTreeTelemetry.treeRowsRebuildCount;

    cacheState.tokens['/notes.txt'] = 7;
    act(() => {
      ready.onTokenResolved(`${ROOT}|@|/notes.txt`);
    });

    expect(new Set(readKeys)).toEqual(new Set([`${ROOT}|@|/notes.txt`]));
    // No row rebuild: the seam never invalidates the row model.
    expect(fileTreeTelemetry.treeRowsRebuildCount).toBe(rowBuildsBefore);
    expect(within(rowFor('notes.txt')).getByTitle('7 tokens')).toBeInTheDocument();
  });

  it('performs one sorted-row rebuild when a pending token count lands', async () => {
    const sortedTree = [file('/a.ts', 10), file('/b.ts', 20)];
    cacheState.tokens['/a.ts'] = 10;
    useExplorerSortStateStore.getState().setSortState({ direction: 'asc', field: 'tokens' });
    let metadata: ExplorerRowMetadata | null = null;
    await renderGrid(sortedTree, (value) => {
      metadata = value;
    });
    const ready = metadata as ExplorerRowMetadata | null;
    if (!ready) {
      throw new Error('expected the harness to expose the metadata seam');
    }
    const rowOrder = (): string[] =>
      screen
        .getAllByRole('row')
        .map((row) => row.getAttribute('data-node-id'))
        .filter((nodeId): nodeId is string => nodeId !== null);
    expect(rowOrder()).toEqual(['/a.ts', '/b.ts']);
    const rowBuildsBefore = fileTreeTelemetry.treeRowsRebuildCount;

    cacheState.tokens['/b.ts'] = 5;
    act(() => {
      ready.onTokenResolved(`${ROOT}|@|/b.ts`);
    });

    expect(rowOrder()).toEqual(['/b.ts', '/a.ts']);
    expect(fileTreeTelemetry.treeRowsRebuildCount).toBe(rowBuildsBefore + 1);
  });
});
