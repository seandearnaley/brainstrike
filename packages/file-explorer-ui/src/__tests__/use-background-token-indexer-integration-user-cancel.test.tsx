/**
 * A user cancel settles the background token indexer's batch as that cancel (BST-2118).
 *
 * Clearing the whole selection cancels the worker batch still in flight. The
 * cancel used to settle as three error-level failures. The integration now owns
 * one cancellation object per cancel, the indexer settles the batch with it, and
 * the dispatch recognizes it by identity. A real worker failure still fails loudly.
 *
 * These run the real `useBackgroundTokenIndexer` against a fake Worker, so the
 * whole chain from the cancel to the integration's logs is exercised.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import type { FileTreeIndexContextValue } from '../tree/file-tree-provider';

const mockWorkers: MockWorker[] = [];

class MockWorker {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event | string) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  public readonly postMessage = vi.fn((_message: unknown) => {});
  public readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(
    public url: string | URL,
    _opts?: WorkerOptions
  ) {
    mockWorkers.push(this);
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((registered) => registered !== listener)
    );
  }

  emitMessage(data: unknown): void {
    const event = { data } as MessageEvent;
    this.onmessage?.(event);
    for (const listener of this.listeners.get('message') ?? []) {
      listener(event);
    }
  }
}

const tokenCacheContext = {
  cacheVersion: 0,
  clearHotCache: vi.fn(),
  countingMode: 'accurate',
  countTextTokens: vi.fn(async () => 0),
  getFileSize: vi.fn(),
  getTokenCount: vi.fn(),
  getTotalTokens: vi.fn(async () => 0),
  invalidate: vi.fn(),
  isAnyLoading: false,
  isLoading: vi.fn(() => false),
  isOperational: true,
  isPersisted: false,
  isReady: true,
  isWorkerReady: true,
  persistenceMode: 'memory',
  preloadFolder: vi.fn(),
  queueForCounting: vi.fn(),
  store: {
    get: vi.fn(async () => null),
    getBatch: vi.fn(async () => new Map()),
    set: vi.fn(async () => {}),
  },
  updateFileSizeCache: vi.fn(),
  updateHotCache: vi.fn(),
} as unknown as TokenCacheContextValue;

const fileTreeIndexContext: FileTreeIndexContextValue = {
  getHandle: vi.fn((_folderId: string, path: string) => ({
    electronHandle: {
      kind: 'file' as const,
      name: path,
      path: `/repo/${path}`,
      platform: 'electron' as const,
    },
    fileName: path,
    fileSize: 128,
  })),
  getNode: vi.fn(() => undefined),
  stats: { totalDirectories: 0, totalFiles: 1, totalNodes: 1 },
  version: 1,
};

vi.mock('../indexing/token-cache-context', () => ({
  useOptionalTokenCacheContext: () => tokenCacheContext,
}));

vi.mock('../tree/file-tree-provider', () => ({
  useOptionalFileTreeIndexContext: () => fileTreeIndexContext,
}));

const fileKey = encodeFileSelection('root', 'file-0.ts');

type IntegrationModule = typeof import('../indexing/use-background-token-indexer-integration');
type LoggingModule = typeof import('@brainstrike/logging');

let integration: IntegrationModule;
let logging: LoggingModule;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('Worker', MockWorker);
  mockWorkers.length = 0;
  logging = await import('@brainstrike/logging');
  integration = await import('../indexing/use-background-token-indexer-integration');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function recordErrors(): { errors: string[]; stop: () => void } {
  const errors: string[] = [];
  const stop = logging.addLogListener((record) => {
    if (record.level === logging.LogLevel.ERROR) {
      errors.push(`[${record.scope}] ${record.message}`);
    }
  });
  return { errors, stop };
}

/** Select one Electron file and hold its batch in the worker, unanswered. */
async function renderWithSelectedBatchInFlight() {
  const view = renderHook(
    (selectedFiles: Set<string>) =>
      integration.useBackgroundTokenIndexerIntegration({
        electronFileReader: async () => 'export const value = 1;',
        fileTree: [],
        selectedFiles,
      }),
    { initialProps: new Set([fileKey]) }
  );
  let dispatch!: Promise<void>;
  act(() => {
    dispatch = view.result.current.triggerIndexing([fileKey]);
  });
  const worker = await waitFor(() => {
    expect(mockWorkers).toHaveLength(1);
    return mockWorkers[0] as MockWorker;
  });
  act(() => {
    worker.emitMessage({ type: 'ready' });
  });
  await waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'index-batch' })
    )
  );
  return { dispatch, view, worker };
}

describe('background token indexing under a user cancel', () => {
  it('settles the batch in flight as the cancel when the whole selection clears, logging no error', async () => {
    const { errors, stop } = recordErrors();
    try {
      const { dispatch, view, worker } = await renderWithSelectedBatchInFlight();

      // Clearing the whole selection cancels the worker batch in flight.
      view.rerender(new Set());
      await act(async () => {
        await dispatch;
      });
      // A cancel keeps the worker for later batches.
      expect(worker.terminate).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      stop();
    }
    expect(errors).toEqual([]);
  });

  it('still logs a real worker failure of the batch in flight at every site', async () => {
    const { errors, stop } = recordErrors();
    try {
      const { dispatch, view, worker } = await renderWithSelectedBatchInFlight();

      act(() => {
        worker.emitMessage({
          compositeKey: '__batch__',
          error: 'batch worker failed',
          id: '__batch__',
          type: 'error',
        });
      });
      await act(async () => {
        await dispatch;
      });
      view.unmount();
    } finally {
      stop();
    }
    // The worker failure, the indexer's own failure and the integration's dispatch.
    expect(errors).toEqual([
      '[BackgroundTokenIndexerIntegration] Background indexer terminal worker error',
      '[BackgroundTokenIndexer] Background token indexer entered failed state',
      '[BackgroundTokenIndexer] indexFiles failed before dispatch',
      '[BackgroundTokenIndexerIntegration] triggerIndexing electron batch dispatch failed',
    ]);
  });

  it('recognizes only the exact cancellation objects its owner issued', async () => {
    const { useIndexingCancellation } = await import(
      '../indexing/background-token-indexer-cancellation'
    );
    const factoryReset = await import('@brainstrike/app-state/factory-reset');
    const indexer = { cancelIndexing: vi.fn(), retire: vi.fn() };
    const { result, unmount } = renderHook(() => useIndexingCancellation({ current: indexer }));
    const lookalike = new Error('The selection was cleared; its token indexing is cancelled');

    act(() => {
      result.current.cancel();
    });
    const [cancellation] = indexer.cancelIndexing.mock.calls[0] as [Error];
    expect(result.current.settledByOwner(cancellation, 'test')).toBe(true);
    expect(result.current.settledByOwner(lookalike, 'test')).toBe(false);

    await act(async () => {
      await factoryReset.prepareFactoryReset();
    });
    const [retirement] = indexer.retire.mock.calls[0] as [Error];
    expect(result.current.isRetired()).toBe(true);
    expect(result.current.settledByOwner(retirement, 'test')).toBe(true);
    // A retired owner still reports a failure that is not its retirement.
    expect(result.current.settledByOwner(new Error(retirement.message), 'test')).toBe(false);
    unmount();
  });
});
