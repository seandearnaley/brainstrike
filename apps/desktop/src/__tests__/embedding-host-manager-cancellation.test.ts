import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lifecycle, windowMock } = vi.hoisted(() => {
  const windowMock = {
    isDestroyed: vi.fn(() => false),
    webContents: { id: 91, send: vi.fn() },
  };
  const status = {
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    runtimeKind: 'embedding-host',
    state: 'running',
  };
  return {
    lifecycle: {
      ensureStarted: vi.fn(async () => status),
      getHostWindow: vi.fn(() => windowMock),
      getStatus: vi.fn(() => status),
      isHostWindow: vi.fn(() => false),
      setStatus: vi.fn(),
    },
    windowMock,
  };
});

vi.mock('electron', () => ({
  powerSaveBlocker: { isStarted: vi.fn(() => false), start: vi.fn(() => 1), stop: vi.fn() },
}));
vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockRendererHostLifecycle() {
    return lifecycle;
  }),
}));

import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { EmbeddingHostManager } from '../embedding-host-manager';
import {
  createEmbeddingHostDocumentCancellationError,
  createEmbeddingHostDocumentEmbeddingsErrorReport,
  createEmbeddingHostDocumentEmbeddingsProgressReport,
  createEmbeddingHostQueryCancellationError,
  createEmbeddingHostQueryEmbeddingErrorReport,
  type EmbeddingHostDocumentEmbeddingsRequest,
  type EmbeddingHostQueryEmbeddingRequest,
} from '../embedding-host-shared';
import { EMBEDDING_HOST_UNRESPONSIVE_CODE } from '../embedding-host-unresponsive';

const QUERY = {
  dimensions: 2,
  modelId: 'local-model',
  modelKey: 'local::local-model',
  query: 'hello',
};

describe('EmbeddingHostManager query cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.ensureStarted.mockImplementation(async () => lifecycle.getStatus());
  });

  it('aborts a query while the shared embedding host is still starting', async () => {
    const startup = Promise.withResolvers<ReturnType<typeof lifecycle.getStatus>>();
    lifecycle.ensureStarted.mockReturnValueOnce(startup.promise);
    const manager = new EmbeddingHostManager();
    const controller = new AbortController();
    const reason = new Error('tool stopped during host startup');
    const query = manager.queryEmbedding(QUERY, { signal: controller.signal });

    controller.abort(reason);
    await expect(query).rejects.toBe(reason);
    expect(windowMock.webContents.send).not.toHaveBeenCalled();

    startup.resolve(lifecycle.getStatus());
    await Promise.resolve();
    expect(windowMock.webContents.send).not.toHaveBeenCalled();
  });

  it('observes a late shared-host startup failure after its query caller aborts', async () => {
    const startup = Promise.withResolvers<ReturnType<typeof lifecycle.getStatus>>();
    lifecycle.ensureStarted.mockReturnValueOnce(startup.promise);
    const manager = new EmbeddingHostManager();
    const controller = new AbortController();
    const reason = new Error('tool stopped during host startup');
    const query = manager.queryEmbedding(QUERY, { signal: controller.signal });

    controller.abort(reason);
    await expect(query).rejects.toBe(reason);
    startup.reject(new Error('shared host failed later'));
    await Promise.resolve();
    expect(windowMock.webContents.send).not.toHaveBeenCalled();
  });

  it('rejects an already-aborted query without starting the host', async () => {
    const manager = new EmbeddingHostManager();
    const controller = new AbortController();
    const reason = new Error('tool stopped');
    controller.abort(reason);

    await expect(manager.queryEmbedding(QUERY, { signal: controller.signal })).rejects.toBe(reason);
    expect(lifecycle.ensureStarted).not.toHaveBeenCalled();
    expect(windowMock.webContents.send).not.toHaveBeenCalled();
  });

  it('retains a pending query request until its canceled renderer completes', async () => {
    const manager = new EmbeddingHostManager();
    const controller = new AbortController();
    const reason = new Error('tool stopped');
    const embeddingPromise = manager.queryEmbedding(QUERY, { signal: controller.signal });
    const observedRejection = embeddingPromise.then(
      () => null,
      (error: unknown) => error
    );
    await lifecycle.ensureStarted.mock.results[0]?.value;
    await vi.waitFor(() => expect(manager.getPlatformStatus().pendingRequestCount).toBe(1));

    const request = windowMock.webContents.send.mock
      .calls[0]?.[1] as EmbeddingHostQueryEmbeddingRequest;
    controller.abort(reason);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    manager.acceptQueryEmbeddingResponseReport(
      91,
      createEmbeddingHostQueryEmbeddingErrorReport(
        request,
        createEmbeddingHostQueryCancellationError()
      )
    );
    await expect(observedRejection).resolves.toBe(reason);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
});

const DOCUMENT = {
  dimensions: 384,
  inferencePlan: {
    device: 'wasm' as const,
    dimensions: 384 as const,
    dtype: 'q8' as const,
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  },
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'native:documents',
  texts: ['first', 'second'],
};
describe('document batch manager cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.ensureStarted.mockImplementation(async () => lifecycle.getStatus());
  });
  it('aborts while starting without submitting hidden work', async () => {
    const startup = Promise.withResolvers<ReturnType<typeof lifecycle.getStatus>>();
    lifecycle.ensureStarted.mockReturnValueOnce(startup.promise);
    const manager = new EmbeddingHostManager();
    const controller = new AbortController();
    const result = manager.documentEmbeddings(DOCUMENT, { signal: controller.signal });
    const reason = new Error('cancel startup');
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    startup.resolve(lifecycle.getStatus());
    await Promise.resolve();
    expect(windowMock.webContents.send).not.toHaveBeenCalled();
  });
  it('sends cancellation with exactly the active request/runtime identity', async () => {
    const manager = new EmbeddingHostManager();
    const controller = new AbortController();
    const result = manager.documentEmbeddings(DOCUMENT, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow('cancel documents');
    await vi.waitFor(() => expect(windowMock.webContents.send).toHaveBeenCalledOnce());
    const request = windowMock.webContents.send.mock.calls[0]?.[1] as {
      requestId: string;
      runtimeId: string;
    };
    controller.abort(new Error('cancel documents'));
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    manager.acceptDocumentEmbeddingsResponseReport(
      91,
      createEmbeddingHostDocumentEmbeddingsErrorReport(
        request as EmbeddingHostDocumentEmbeddingsRequest,
        createEmbeddingHostDocumentCancellationError()
      )
    );
    await rejected;
    expect(windowMock.webContents.send).toHaveBeenLastCalledWith(
      'embedding-host:document-embeddings-cancel',
      {
        channel: 'document-embeddings-cancel',
        payload: {},
        requestId: request.requestId,
        runtimeId: request.runtimeId,
        type: 'request',
      }
    );
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('does not settle a document response from another runtime with the same request id', async () => {
    const manager = new EmbeddingHostManager();
    const controller = new AbortController();
    const result = manager.documentEmbeddings(DOCUMENT, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow('cancel after stale response');
    await vi.waitFor(() => expect(windowMock.webContents.send).toHaveBeenCalledOnce());
    const request = windowMock.webContents.send.mock.calls[0]?.[1] as {
      requestId: string;
      runtimeId: string;
    };
    manager.acceptDocumentEmbeddingsResponseReport(91, {
      ...request,
      channel: 'document-embeddings-result',
      payload: { embeddings: DOCUMENT.texts.map(() => Array.from({ length: 384 }, () => 0.1)) },
      runtimeId: 'stale-runtime',
      type: 'result',
    });
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    controller.abort(new Error('cancel after stale response'));
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    manager.acceptDocumentEmbeddingsResponseReport(
      91,
      createEmbeddingHostDocumentEmbeddingsErrorReport(
        request as EmbeddingHostDocumentEmbeddingsRequest,
        createEmbeddingHostDocumentCancellationError()
      )
    );
    await rejected;
  });
  it('keeps a document batch alive while the host reports progress past one timeout window', async () => {
    // Recorded: a granite WASM batch of dense chunks outlived the fixed 60 s window and
    // blocked the index ("Embedding host request ... timed out after 60000ms").
    vi.useFakeTimers();
    try {
      const manager = new EmbeddingHostManager();
      const result = manager.documentEmbeddings(DOCUMENT);
      await vi.advanceTimersByTimeAsync(0);
      expect(windowMock.webContents.send).toHaveBeenCalledOnce();
      const request = windowMock.webContents.send.mock
        .calls[0]?.[1] as EmbeddingHostDocumentEmbeddingsRequest;
      await vi.advanceTimersByTimeAsync(50_000);
      manager.acceptDocumentEmbeddingsResponseReport(
        91,
        createEmbeddingHostDocumentEmbeddingsProgressReport(request, {
          completed: 1,
          stage: 'inference',
        })
      );
      await vi.advanceTimersByTimeAsync(50_000);
      manager.acceptDocumentEmbeddingsResponseReport(91, {
        ...request,
        channel: 'document-embeddings-result',
        payload: { embeddings: DOCUMENT.texts.map(() => Array.from({ length: 384 }, () => 0.1)) },
        type: 'result',
      });
      await expect(result).resolves.toHaveLength(DOCUMENT.texts.length);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps a document batch alive while model setup reports progress past several windows (BST-2104)', async () => {
    // A first run downloads and loads the model before the first slice can report.
    vi.useFakeTimers();
    try {
      const manager = new EmbeddingHostManager();
      const result = manager.documentEmbeddings(DOCUMENT);
      let settled = false;
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await vi.advanceTimersByTimeAsync(0);
      const request = windowMock.webContents.send.mock
        .calls[0]?.[1] as EmbeddingHostDocumentEmbeddingsRequest;
      for (let heartbeat = 0; heartbeat < 6; heartbeat += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        manager.acceptDocumentEmbeddingsResponseReport(
          91,
          createEmbeddingHostDocumentEmbeddingsProgressReport(request, { stage: 'setup' })
        );
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      manager.acceptDocumentEmbeddingsResponseReport(91, {
        ...request,
        channel: 'document-embeddings-result',
        payload: { embeddings: DOCUMENT.texts.map(() => Array.from({ length: 384 }, () => 0.1)) },
        type: 'result',
      });
      await expect(result).resolves.toHaveLength(DOCUMENT.texts.length);
    } finally {
      vi.useRealTimers();
    }
  });
  it('times a document batch out one window after model setup goes silent (BST-2104)', async () => {
    vi.useFakeTimers();
    try {
      const manager = new EmbeddingHostManager();
      let settled = false;
      const failure = manager.documentEmbeddings(DOCUMENT).then(
        () => {
          throw new Error('The silent batch resolved.');
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );
      await vi.advanceTimersByTimeAsync(0);
      const request = windowMock.webContents.send.mock
        .calls[0]?.[1] as EmbeddingHostDocumentEmbeddingsRequest;
      await vi.advanceTimersByTimeAsync(30_000);
      manager.acceptDocumentEmbeddingsResponseReport(
        91,
        createEmbeddingHostDocumentEmbeddingsProgressReport(request, { stage: 'setup' })
      );
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // The timeout leads; this fixture's host cannot acknowledge the Stop that retires it.
      const error = await failure;
      const timeout = error instanceof AggregateError ? error.errors[0] : error;
      // The blocked state's cause: the stage the batch went silent in and its elapsed time, in
      // plain words; the request identity stays in the log (BST-2104 part 2).
      expect(timeout).toBeInstanceOf(BoundaryFailureError);
      expect((timeout as BoundaryFailureError).failure).toMatchObject({
        code: EMBEDDING_HOST_UNRESPONSIVE_CODE,
        kind: 'refusal',
        message:
          'The embedding model stopped responding while it was loading. It sent no progress for 1 min (1 min 30 s after the batch started).',
        remedy: 'Retry indexing restarts the embedding model and resumes indexing.',
      });
      expect((timeout as Error).message).not.toContain(request.requestId);
    } finally {
      vi.useRealTimers();
    }
  });
  it('names how far inference got when a batch goes silent between slices (BST-2104)', async () => {
    vi.useFakeTimers();
    try {
      const manager = new EmbeddingHostManager();
      const failure = manager.documentEmbeddings(DOCUMENT).then(
        () => {
          throw new Error('The silent batch resolved.');
        },
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(0);
      const request = windowMock.webContents.send.mock
        .calls[0]?.[1] as EmbeddingHostDocumentEmbeddingsRequest;
      manager.acceptDocumentEmbeddingsResponseReport(
        91,
        createEmbeddingHostDocumentEmbeddingsProgressReport(request, { stage: 'setup' })
      );
      await vi.advanceTimersByTimeAsync(10_000);
      manager.acceptDocumentEmbeddingsResponseReport(
        91,
        createEmbeddingHostDocumentEmbeddingsProgressReport(request, {
          completed: 1,
          stage: 'inference',
        })
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const error = await failure;
      const timeout = error instanceof AggregateError ? error.errors[0] : error;
      expect((timeout as BoundaryFailureError).failure.message).toBe(
        'The embedding model stopped responding after 1 of 2 chunks in a batch. It sent no progress for 1 min (1 min 10 s after the batch started).'
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects count/dimension mismatches independently at the main receiver', async () => {
    const manager = new EmbeddingHostManager();
    const result = manager.documentEmbeddings(DOCUMENT);
    const rejected = expect(result).rejects.toThrow('count or dimensions');
    await vi.waitFor(() => expect(windowMock.webContents.send).toHaveBeenCalledOnce());
    const request = windowMock.webContents.send.mock.calls[0]?.[1] as {
      requestId: string;
      runtimeId: string;
    };
    manager.acceptDocumentEmbeddingsResponseReport(91, {
      ...request,
      channel: 'document-embeddings-result',
      payload: { embeddings: [[0.1]] },
      type: 'result',
    });
    await rejected;
  });
});
