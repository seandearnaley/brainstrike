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
import {
  TOKEN_INDEXER_BATCH_YIELD_MS,
  TOKEN_INDEXER_IO_BATCH_SIZE,
  VISIBLE_FILE_INDEXING_DEBOUNCE_MS,
  VISIBLE_FILE_INDEXING_MAX_PER_PASS,
} from '../constants';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import { useBackgroundTokenIndexerIntegration } from '../indexing/use-background-token-indexer-integration';
import { shouldRearmVisibleFileIndexing } from '../indexing/use-visible-file-token-indexing';

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

/** A tree big enough to overflow one capped pass, plus its composite keys. */
function buildOversizedTree(fileCount: number): { keys: Set<string>; tree: IFileNode[] } {
  const tree: IFileNode[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < fileCount; index += 1) {
    const path = `bulk-${index}.txt`;
    tree.push(fileNode(path));
    keys.add(encodeFileSelection('root', path));
  }
  return { keys, tree };
}

const EMPTY_SELECTION = new Set<string>();

/** Long enough to clear the handle-map rebuild AND the visible-file throttle. */
const SETTLE_MS = 5000;

/**
 * Runs pending timers AND drains the microtask queue: the visible-file pass is
 * async (it awaits the persistent-cache warm before dispatching), so timer
 * advancement alone leaves the dispatch parked in a promise continuation.
 */
async function flushTimers(passes = 3): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

/**
 * Advance exactly one visible-file pass: its debounce, then the cooperative
 * yields between dispatch batches. Stays well inside the next pass's debounce
 * so passes stay individually observable.
 */
async function drainOnePass(): Promise<void> {
  // Two debounce-length advances: the handle-map rebuild has to land and
  // re-render before the visible effect can schedule its own timer (and, on the
  // second pass, the re-arm has to fire before the new timer is scheduled).
  for (let step = 0; step < 2; step += 1) {
    await act(async () => {
      vi.advanceTimersByTime(VISIBLE_FILE_INDEXING_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  const yieldsPerPass =
    Math.ceil(VISIBLE_FILE_INDEXING_MAX_PER_PASS / TOKEN_INDEXER_IO_BATCH_SIZE) - 1;
  for (let step = 0; step < yieldsPerPass; step += 1) {
    await act(async () => {
      vi.advanceTimersByTime(TOKEN_INDEXER_BATCH_YIELD_MS);
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

  it('never re-arms a completed pass after its effect was cancelled', () => {
    expect(
      shouldRearmVisibleFileIndexing({
        cancelled: true,
        candidateCount: 500,
        remainingCount: 20,
      })
    ).toBe(false);
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

  it('caps one pass and re-arms for the remainder', async () => {
    // Expanding a large directory surfaces every descendant at once, and each
    // uncached file costs a full-content read. Time is advanced explicitly here
    // (not `runAllTimers`) so the assertion can land in the window AFTER one
    // pass has fully drained but BEFORE the re-arm debounce elapses — which is
    // the only way to see the cap rather than the final total.
    const overflow = 20;
    const { keys, tree } = buildOversizedTree(VISIBLE_FILE_INDEXING_MAX_PER_PASS + overflow);
    renderHook(() =>
      useBackgroundTokenIndexerIntegration({
        fileTree: tree,
        selectedFiles: EMPTY_SELECTION,
        visibleFiles: keys,
      })
    );

    await drainOnePass();
    expect(indexedPaths()).toHaveLength(VISIBLE_FILE_INDEXING_MAX_PER_PASS);

    // Nothing changed except that the first batch landed; the pass re-arms.
    await drainOnePass();
    expect(indexedPaths()).toHaveLength(VISIBLE_FILE_INDEXING_MAX_PER_PASS + overflow);
  });

  it('does not re-arm when a pass consumed nothing', async () => {
    // Every key resolves from cache into `indexedFilesRef` on the first pass,
    // so the second pass has no candidates and must simply stop.
    getTokenCountMock.mockReturnValue(1234);
    renderHook(() =>
      useBackgroundTokenIndexerIntegration({
        fileTree,
        selectedFiles: EMPTY_SELECTION,
        visibleFiles: new Set([VISIBLE_A, VISIBLE_B]),
      })
    );

    await flushTimers();
    await flushTimers();

    expect(indexFilesMock).not.toHaveBeenCalled();
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
