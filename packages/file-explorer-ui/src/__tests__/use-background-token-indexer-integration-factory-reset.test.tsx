/**
 * Factory reset retires the background token indexer (BST-2092, ADR-0015).
 *
 * Reset's live-store clear remounts FileExplorerProvider's children, and that
 * remount terminates the indexer's worker. A batch still in flight used to settle
 * as three error-level failures. Reset preparation now quiesces the indexer
 * through its owner first, so the reset's own termination settles as the reset's
 * cancellation. The same termination without a reset still fails loudly.
 *
 * These run the real `useBackgroundTokenIndexer` against a fake Worker, so the
 * whole chain from the worker's cleanup to the integration's logs is exercised.
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

type FactoryResetModule = typeof import('@brainstrike/app-state/factory-reset');
type IntegrationModule = typeof import('../indexing/use-background-token-indexer-integration');
type LoggingModule = typeof import('@brainstrike/logging');

// Reset preparation is terminal for a renderer, so every test gets fresh modules.
let factoryReset: FactoryResetModule;
let integration: IntegrationModule;
let logging: LoggingModule;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('Worker', MockWorker);
  mockWorkers.length = 0;
  logging = await import('@brainstrike/logging');
  factoryReset = await import('@brainstrike/app-state/factory-reset');
  integration = await import('../indexing/use-background-token-indexer-integration');
});

afterEach(() => {
  vi.useRealTimers();
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

function renderIntegration(electronFileReader: () => Promise<string>) {
  return renderHook(() =>
    integration.useBackgroundTokenIndexerIntegration({
      electronFileReader,
      fileTree: [],
      selectedFiles: new Set(),
    })
  );
}

/** Index one Electron file and hold its batch in the worker, unanswered. */
async function renderWithBatchInFlight() {
  const view = renderIntegration(async () => 'export const value = 1;');
  let settled = false;
  let dispatch!: Promise<void>;
  act(() => {
    dispatch = view.result.current.triggerIndexing([fileKey]).finally(() => {
      settled = true;
    });
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
  return { dispatch, isSettled: () => settled, view, worker };
}

describe('background token indexing under a factory reset', () => {
  it('settles an in-flight batch as the reset cancellation before the remount terminates the worker', async () => {
    const { errors, stop } = recordErrors();
    let atPreparation: { settled: boolean; terminated: boolean } | undefined;
    try {
      const { dispatch, isSettled, view, worker } = await renderWithBatchInFlight();

      await act(async () => {
        await factoryReset.prepareFactoryReset();
      });
      atPreparation = { settled: isSettled(), terminated: worker.terminate.mock.calls.length > 0 };

      // Reset's live-store clear remounts FileExplorerProvider's children.
      view.unmount();
      await act(async () => {
        await dispatch;
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
    expect(errors).toEqual([]);
    // Preparation joined the owner's dispatch; stopping the worker stayed the remount's.
    expect(atPreparation).toEqual({ settled: true, terminated: false });
  });

  it('still logs the same termination as a failure when no reset owns it', async () => {
    const { errors, stop } = recordErrors();
    try {
      const { dispatch, view, worker } = await renderWithBatchInFlight();

      view.unmount();
      await act(async () => {
        await dispatch;
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
    expect(errors).toEqual([
      '[BackgroundTokenIndexer] indexFiles failed before dispatch',
      '[BackgroundTokenIndexerIntegration] Background indexer terminal worker error',
      '[BackgroundTokenIndexerIntegration] triggerIndexing electron batch dispatch failed',
    ]);
  });

  it('reset preparation joins a file read already in flight, then dispatches nothing', async () => {
    const read = Promise.withResolvers<string>();
    const electronFileReader = vi.fn(() => read.promise);
    const { errors, stop } = recordErrors();
    let preparedBeforeRead = true;
    try {
      const view = renderIntegration(electronFileReader);
      let dispatch!: Promise<void>;
      act(() => {
        dispatch = view.result.current.triggerIndexing([fileKey]);
      });
      await waitFor(() => expect(electronFileReader).toHaveBeenCalledOnce());

      let prepared = false;
      const preparation = factoryReset.prepareFactoryReset().then(() => {
        prepared = true;
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      preparedBeforeRead = prepared;
      await act(async () => {
        read.resolve('export const value = 1;');
        await preparation;
        await dispatch;
      });
      view.unmount();
    } finally {
      stop();
    }
    expect(preparedBeforeRead).toBe(false);
    expect(mockWorkers).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('settles a dispatch still waiting for worker readiness long before the readiness timeout', async () => {
    vi.useFakeTimers();
    const { errors, stop } = recordErrors();
    let preparedPromptly = false;
    let terminatedByTimeout = true;
    try {
      const view = renderIntegration(async () => 'export const value = 1;');
      let dispatch!: Promise<void>;
      act(() => {
        dispatch = view.result.current.triggerIndexing([fileKey]);
      });
      // The worker exists but never signals ready.
      const worker = await vi.waitFor(() => {
        expect(mockWorkers).toHaveLength(1);
        return mockWorkers[0] as MockWorker;
      });

      let prepared = false;
      const preparation = factoryReset.prepareFactoryReset().then(() => {
        prepared = true;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      preparedPromptly = prepared;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        await preparation;
        await dispatch;
      });
      terminatedByTimeout = worker.terminate.mock.calls.length > 0;
      view.unmount();
    } finally {
      stop();
      vi.useRealTimers();
    }
    expect(errors).toEqual([]);
    expect(preparedPromptly).toBe(true);
    // The cancelled readiness timeout never escalates into a restart or failure.
    expect(terminatedByTimeout).toBe(false);
  });

  it('still fails loudly when that readiness wait times out without a reset', async () => {
    vi.useFakeTimers();
    const { errors, stop } = recordErrors();
    try {
      const view = renderIntegration(async () => 'export const value = 1;');
      let dispatch!: Promise<void>;
      act(() => {
        dispatch = view.result.current.triggerIndexing([fileKey]);
      });
      await vi.waitFor(() => expect(mockWorkers).toHaveLength(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        await dispatch;
      });
      view.unmount();
    } finally {
      stop();
      vi.useRealTimers();
    }
    expect(errors).toEqual([
      '[BackgroundTokenIndexerIntegration] triggerIndexing electron batch dispatch failed',
    ]);
  });

  it('a replacement indexer mounted after preparation began reads and dispatches nothing', async () => {
    await factoryReset.prepareFactoryReset();
    const electronFileReader = vi.fn(async () => 'export const value = 1;');
    const { errors, stop } = recordErrors();
    try {
      const view = renderIntegration(electronFileReader);
      await act(async () => {
        await view.result.current.triggerIndexing([fileKey]);
      });
      view.unmount();
    } finally {
      stop();
    }
    expect(electronFileReader).not.toHaveBeenCalled();
    expect(mockWorkers).toHaveLength(0);
    expect(errors).toEqual([]);
  });
});
