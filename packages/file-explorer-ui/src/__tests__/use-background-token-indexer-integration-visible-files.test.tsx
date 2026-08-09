/**
 * Visible-file token indexing trigger (BST-1207, decision D2).
 *
 * Indexing used to start only when files were SELECTED, so the Explorer tree's
 * token column would sit at `pending` for every row the user had merely
 * expanded. These tests pin the second trigger source: visible + expanded files
 * are indexed too — cached-first (the persistent cache is warmed and consulted
 * before any work is dispatched), throttled behind the selection trigger, and
 * through the SAME dispatch planner so binary/size policy still applies.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { FileToIndex } from '@brainstrike/token-cache/background-indexer';
import type { IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import { useBackgroundTokenIndexerIntegration } from '../indexing/use-background-token-indexer-integration';

const indexFilesMock = vi.fn<(files: FileToIndex[]) => Promise<void>>(async () => {});
const mockBackgroundIndexer = {
  cancelIndexing: vi.fn(),
  indexFiles: indexFilesMock,
  isIndexing: false,
  isReady: true,
  progress: null,
};

vi.mock('@brainstrike/token-cache/background-indexer', () => ({
  useBackgroundTokenIndexer: () => mockBackgroundIndexer,
}));

const preloadFolderMock = vi.fn(async () => {});
const getTokenCountMock = vi.fn<(folderId: string, filePath: string) => number | null>(() => null);

const tokenCacheContext = {
  cacheVersion: 0,
  clearHotCache: vi.fn(),
  countingMode: 'accurate',
  countTextTokens: vi.fn(async () => 0),
  getFileSize: vi.fn(),
  getTokenCount: getTokenCountMock,
  getTotalTokens: vi.fn(async () => 0),
  invalidate: vi.fn(),
  isAnyLoading: false,
  isLoading: vi.fn(() => false),
  isOperational: true,
  isPersisted: true,
  isReady: true,
  isWorkerReady: true,
  persistenceMode: 'persistent',
  preloadFolder: preloadFolderMock,
  queueForCounting: vi.fn(),
  store: {
    getAllForFolder: vi.fn(async () => []),
    getBatch: vi.fn(async () => new Map()),
  },
  updateFileSizeCache: vi.fn(),
  updateHotCache: vi.fn(),
} as unknown as TokenCacheContextValue;

/** Mutable view for the startup tests that flip persistence mid-run. */
const mutableTokenCacheContext = tokenCacheContext as unknown as {
  isPersisted: boolean;
};

vi.mock('../indexing/token-cache-context', () => ({
  useOptionalTokenCacheContext: () => tokenCacheContext,
}));

vi.mock('../tree/file-tree-provider', () => ({
  useOptionalFileTreeIndexContext: () => null,
}));

const webHandle = { getFile: vi.fn() } as unknown as FileSystemFileHandle;

function fileNode(path: string): IFileNode {
  return {
    depth: 0,
    handle: webHandle,
    name: path.split('/').at(-1) ?? path,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  };
}

const VISIBLE_A = encodeFileSelection('root', 'a.txt');
const VISIBLE_B = encodeFileSelection('root', 'b.txt');
const VISIBLE_BINARY = encodeFileSelection('root', 'logo.png');

const fileTree: IFileNode[] = [fileNode('a.txt'), fileNode('b.txt'), fileNode('logo.png')];

const EMPTY_SELECTION = new Set<string>();

/** Long enough to clear the handle-map rebuild AND the visible-file throttle. */
const SETTLE_MS = 5000;

/**
 * Runs pending timers AND drains the microtask queue: the visible-file pass is
 * async (it awaits the persistent-cache warm before dispatching), so timer
 * advancement alone leaves the dispatch parked in a promise continuation.
 */
async function flushTimers(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

function indexedPaths(): string[] {
  return indexFilesMock.mock.calls.flatMap(([files]) => files.map((file) => file.filePath)).sort();
}

function renderIntegration(props: {
  selectedFiles?: Set<string>;
  visibleFiles?: ReadonlySet<string>;
}) {
  return renderHook(() =>
    useBackgroundTokenIndexerIntegration({
      fileTree,
      selectedFiles: props.selectedFiles ?? EMPTY_SELECTION,
      ...(props.visibleFiles ? { visibleFiles: props.visibleFiles } : {}),
    })
  );
}

/** Render with a re-renderable visible set (for the persistence-transition tests). */
function renderVisibleFiles(initialProps: ReadonlySet<string>) {
  return renderHook(
    (visibleFiles: ReadonlySet<string>) =>
      useBackgroundTokenIndexerIntegration({
        fileTree,
        selectedFiles: EMPTY_SELECTION,
        visibleFiles,
      }),
    { initialProps }
  );
}

describe('useBackgroundTokenIndexerIntegration visible-file trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    getTokenCountMock.mockReturnValue(null);
    mutableTokenCacheContext.isPersisted = true;
  });

  it('indexes visible files that were never selected', async () => {
    renderIntegration({ visibleFiles: new Set([VISIBLE_A, VISIBLE_B]) });
    await flushTimers();

    expect(indexedPaths()).toEqual(['a.txt', 'b.txt']);
  });

  it('warms the persistent cache and skips files it already knows', async () => {
    getTokenCountMock.mockImplementation((_folderId, filePath) =>
      filePath === 'a.txt' ? 1234 : null
    );

    renderIntegration({ visibleFiles: new Set([VISIBLE_A, VISIBLE_B]) });
    await flushTimers();

    expect(preloadFolderMock).toHaveBeenCalledWith('root');
    expect(indexedPaths()).toEqual(['b.txt']);
  });

  it('applies the dispatch planner policy — binaries are never dispatched', async () => {
    renderIntegration({ visibleFiles: new Set([VISIBLE_A, VISIBLE_BINARY]) });
    await flushTimers();

    expect(indexedPaths()).toEqual(['a.txt']);
  });

  it('throttles behind the selection trigger instead of firing immediately', async () => {
    renderIntegration({ visibleFiles: new Set([VISIBLE_A]) });
    // Let the handle map settle, then check that the visible trigger has not
    // fired yet at the selection trigger's own (small-batch) debounce.
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(indexFilesMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(SETTLE_MS);
      await Promise.resolve();
    });
    await flushTimers();
    expect(indexedPaths()).toEqual(['a.txt']);
  });

  it('leaves the selection trigger working when no visible set is supplied', async () => {
    renderIntegration({ selectedFiles: new Set([VISIBLE_A]) });
    await flushTimers();

    expect(indexedPaths()).toEqual(['a.txt']);
  });

  it('does not memoize a warm that ran before the DB was up', async () => {
    // Startup order: the token worker is operational before PGlite is. A warm
    // in that window reads nothing, so remembering it would make every later
    // visible file skip the cache and get a full re-count for the rest of the
    // session.
    mutableTokenCacheContext.isPersisted = false;
    const { rerender } = renderVisibleFiles(new Set([VISIBLE_A]));
    await flushTimers();
    expect(preloadFolderMock).toHaveBeenCalledTimes(1);

    mutableTokenCacheContext.isPersisted = true;
    rerender(new Set([VISIBLE_A, VISIBLE_B]));
    await flushTimers();

    expect(preloadFolderMock).toHaveBeenCalledTimes(2);
  });

  it('warms a folder only once while persistence is already up', async () => {
    const { rerender } = renderVisibleFiles(new Set([VISIBLE_A]));
    await flushTimers();
    expect(preloadFolderMock).toHaveBeenCalledTimes(1);

    rerender(new Set([VISIBLE_A, VISIBLE_B]));
    await flushTimers();

    expect(preloadFolderMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-dispatch a file the selection trigger already queued', async () => {
    renderIntegration({
      selectedFiles: new Set([VISIBLE_A]),
      visibleFiles: new Set([VISIBLE_A, VISIBLE_B]),
    });
    await flushTimers();

    expect(indexedPaths()).toEqual(['a.txt', 'b.txt']);
  });
});
