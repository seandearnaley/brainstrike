/**
 * Structural-change stability for directory rollups (BST-1208, CI review).
 *
 * The reconcile effect keys on `rowStructureRevision` (BST-1209: pure reorders
 * never reach it — pinned by explorer-sort-rebuild-loop.test.tsx). What THIS
 * file pins is stale-while-recompute under a REAL structural revision bump
 * (expand, lazy child load, node add/remove): the effect used to CLEAR the
 * deferral cache and then call `invalidateAll` synchronously, flipping every
 * settled `complete` rollup to PARTIAL for one macrotask — a visible blink
 * behind a recomputing tooltip that was momentarily untrue.
 *
 * Contract: a revision bump whose subtree content did not actually move must
 * notify NOBODY, before or after the deferred refresh lands; a bump whose
 * content DID move must notify.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { act } from '@brainstrike/test-utils/react-act';
import type { IFileNode } from '@brainstrike/types';
import { render } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ExplorerRowMetadata,
  useExplorerRowMetadata,
} from '../indexing/file-row-metadata-context';
import { FileRowMetadataProvider } from '../indexing/file-row-metadata-provider';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import { useFileTreeMetadataSource } from '../tree/use-file-tree-metadata-source';
import { FileExplorerTestWrapper } from './test-helpers';

const ROOT = 'root';
const DIRECTORY_KEY = encodeFileSelection(ROOT, '/src');

let tokens: Record<string, number>;

vi.mock('../indexing/token-cache-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../indexing/token-cache-context')>();
  return {
    ...actual,
    useOptionalTokenCacheContext: (): TokenCacheContextValue =>
      ({
        cacheVersion: 1,
        getFileSize: () => undefined,
        getTokenCount: (_folderId: string, path: string) => tokens[path] ?? null,
        isOperational: true,
      }) as unknown as TokenCacheContextValue,
  };
});

function file(path: string, size: number): IFileNode {
  return {
    depth: 1,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: ROOT,
    selectionState: 'unchecked',
    size,
    type: 'file',
  };
}

const FILE_TREE: IFileNode[] = [
  {
    children: [file('/src/a.ts', 100), file('/src/b.ts', 20)],
    depth: 0,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    loadState: 'loaded',
    name: 'src',
    path: '/src',
    rootFolderId: ROOT,
    selectionState: 'unchecked',
    type: 'directory',
  },
];

/** Mounts the source only — no TreeTable, so the revision is fully controllable. */
function SourceMount({ rowStructureRevision }: { rowStructureRevision: number }) {
  useFileTreeMetadataSource({
    fileTree: FILE_TREE,
    filteredPathSet: null,
    folderId: ROOT,
    normalizedTreeContext: null,
    rowStructureRevision,
    visibleAggregates: null,
  });
  return null;
}

function Harness({
  onReady,
  rowStructureRevision,
}: {
  onReady: (metadata: ExplorerRowMetadata) => void;
  rowStructureRevision: number;
}) {
  const rowMetadata = useExplorerRowMetadata();
  useEffect(() => {
    onReady(rowMetadata);
  }, [onReady, rowMetadata]);
  return (
    <FileRowMetadataProvider value={rowMetadata.contextValue}>
      <SourceMount rowStructureRevision={rowStructureRevision} />
    </FileRowMetadataProvider>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

describe('directory rollup stability across structural changes', () => {
  beforeEach(() => {
    tokens = { '/src/a.ts': 10, '/src/b.ts': 5 };
  });

  it('does not notify a subscriber when a revision bump leaves the subtree unchanged', async () => {
    let metadata: ExplorerRowMetadata | null = null;
    const onReady = (value: ExplorerRowMetadata) => {
      metadata = value;
    };

    const view = await act(async () =>
      render(
        <FileExplorerTestWrapper>
          <Harness onReady={onReady} rowStructureRevision={1} />
        </FileExplorerTestWrapper>
      )
    );
    await settle();

    const ready = metadata as ExplorerRowMetadata | null;
    if (!ready) {
      throw new Error('expected the harness to expose the metadata seam');
    }
    const { store } = ready.contextValue;

    // A mounted directory cell: subscribe, take the first (deferred) read, then
    // let the batch resolve — exactly the sequence a real cell goes through.
    const listener = vi.fn();
    store.subscribe(DIRECTORY_KEY, listener);
    expect(store.getDirectorySnapshot(DIRECTORY_KEY)).toMatchObject({ status: 'partial' });
    await settle();
    expect(store.getDirectorySnapshot(DIRECTORY_KEY)).toMatchObject({
      status: 'complete',
      tokens: 15,
    });
    // From here the cell is settled; anything below is the regression under test.
    listener.mockClear();

    // The common interaction: expand/lazy-load bumps the structure revision
    // while the directory's content is identical.
    await act(async () => {
      view.rerender(
        <FileExplorerTestWrapper>
          <Harness onReady={onReady} rowStructureRevision={2} />
        </FileExplorerTestWrapper>
      );
    });

    // Synchronously after the reconcile: no blink to PARTIAL.
    expect(store.getDirectorySnapshot(DIRECTORY_KEY)).toMatchObject({
      status: 'complete',
      tokens: 15,
    });
    expect(listener).not.toHaveBeenCalled();

    // And nothing once the deferred refresh resolves either: the recomputed
    // rollup compares equal, so the store stays silent.
    await settle();
    expect(listener).not.toHaveBeenCalled();
    expect(store.getDirectorySnapshot(DIRECTORY_KEY)).toMatchObject({
      status: 'complete',
      tokens: 15,
    });
  });

  it('still repaints when a structural change DOES move the rollup', async () => {
    let metadata: ExplorerRowMetadata | null = null;
    const onReady = (value: ExplorerRowMetadata) => {
      metadata = value;
    };

    const view = await act(async () =>
      render(
        <FileExplorerTestWrapper>
          <Harness onReady={onReady} rowStructureRevision={1} />
        </FileExplorerTestWrapper>
      )
    );
    await settle();

    const ready = metadata as ExplorerRowMetadata | null;
    if (!ready) {
      throw new Error('expected the harness to expose the metadata seam');
    }
    const { store } = ready.contextValue;
    const listener = vi.fn();
    store.subscribe(DIRECTORY_KEY, listener);
    store.getDirectorySnapshot(DIRECTORY_KEY);
    await settle();
    expect(store.getDirectorySnapshot(DIRECTORY_KEY)).toMatchObject({ tokens: 15 });
    listener.mockClear();

    // A real change behind the same structural signal.
    tokens['/src/b.ts'] = 25;
    await act(async () => {
      view.rerender(
        <FileExplorerTestWrapper>
          <Harness onReady={onReady} rowStructureRevision={2} />
        </FileExplorerTestWrapper>
      );
    });

    expect(listener).toHaveBeenCalled();
    expect(store.getDirectorySnapshot(DIRECTORY_KEY)).toMatchObject({
      status: 'complete',
      tokens: 35,
    });
  });
});
