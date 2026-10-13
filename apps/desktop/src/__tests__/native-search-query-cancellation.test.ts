import { EventEmitter } from 'node:events';
import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { NativeWorkspaceSearchExecutor } from '@brainstrike/workspace-search/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmbeddingHostQueryCancellationResult,
  EmbeddingHostQueryEmbeddingPayload,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostStatus,
} from '../embedding-host-shared';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  lifecycle: null as unknown as {
    ensureStarted: () => Promise<EmbeddingHostStatus>;
    getHostWindow: () => unknown;
    getStatus: () => EmbeddingHostStatus;
    setStatus: (status: EmbeddingHostStatus) => void;
    waitForStatus: ReturnType<typeof vi.fn>;
    clearHostWindow: ReturnType<typeof vi.fn>;
    destroyHostWindow: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  },
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      fixture.handlers.set(channel, handler)
    ),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn() },
}));
vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockLifecycle() {
    return fixture.lifecycle;
  }),
}));

import { EmbeddingHostManager } from '../embedding-host-manager';
import {
  createEmbeddingHostQueryCancellationError,
  createEmbeddingHostQueryEmbeddingErrorReport,
} from '../embedding-host-shared';
import { registerEmbeddingHostIpcHandlers } from '../ipc-embedding-host';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { generateDesktopQueryEmbedding } from '../renderer/query-embeddings';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../window-role';
import { createAllowlistedSenderFrame } from './helpers/desktop-ipc-sender-frame-test-allowlist';

const profile = {
  dimensions: 384,
  dtype: 'fp16' as const,
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  tokenCap: 256,
};
const payload = {
  dimensions: 384,
  // The worker plan Main resolves: execution choices only, never the profile's token cap.
  inferencePlan: {
    device: 'webgpu' as const,
    dimensions: 384 as const,
    dtype: profile.dtype,
    modelId: profile.modelId,
    revision: profile.revision,
  },
  modelId: profile.modelId,
  modelKey: 'native:queries',
  query: 'needle',
};
const embedding = {
  indexMode: 'vector-configured' as const,
  profile,
  profileHash: '60a05b1084b11c2add2e01bb8112960f51e83e68c88ad4151b0dc54eb69e1914',
};
const counts = { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 };
const vector = Array.from({ length: 384 }, () => 0.1);
const searchRequest = {
  caseSensitive: false,
  collectionId: null,
  isRegex: false,
  query: 'needle',
  rootIds: ['root-a'],
  wholeWord: false,
};
const flush = async (): Promise<void> => {
  for (let index = 0; index < 30; index += 1) {
    await Promise.resolve();
  }
};
const sender = (id: number) => Object.assign(new EventEmitter(), { id });
type Sender = ReturnType<typeof sender>;

describe('actual native search to query IPC physical owner', () => {
  let manager: EmbeddingHostManager;
  let hidden: EventEmitter & {
    webContents: EventEmitter & { id: number; send: ReturnType<typeof vi.fn> };
    destroy: ReturnType<typeof vi.fn<() => void>>;
    isDestroyed: () => boolean;
  };
  let senderA: Sender;
  let senderB: Sender;
  let unregister: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    fixture.handlers.clear();
    const status: EmbeddingHostStatus = {
      active: false,
      lastError: null,
      runtimeId: 'query-runtime',
      runtimeKind: 'embedding-host',
      state: 'running',
    };
    hidden = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      isDestroyed: () => false,
      webContents: Object.assign(new EventEmitter(), { id: 91, send: vi.fn() }),
    });
    fixture.lifecycle = {
      clearHostWindow: vi.fn(),
      destroyHostWindow: vi.fn(() => hidden.destroy()),
      dispose: vi.fn(),
      ensureStarted: async () => fixture.lifecycle.getStatus(),
      getHostWindow: () => hidden,
      getStatus: () => status,
      setStatus: (next) => Object.assign(status, next),
      waitForStatus: vi.fn(),
    };
    manager = new EmbeddingHostManager({ platform: 'linux' });
    unregister = registerEmbeddingHostIpcHandlers(manager, { stop: () => manager.stop() });
    senderA = sender(301);
    senderB = sender(302);
    for (const requester of [senderA, senderB]) {
      assignWindowRole({ once: vi.fn(), webContents: requester } as never, 'visible-ui');
    }
    Object.defineProperty(window, 'embeddingHost', {
      configurable: true,
      value: {
        cancelQueryEmbedding: (requestId: string) =>
          invoke(
            senderA,
            DESKTOP_IPC_CHANNELS.embeddingHost.cancelQueryEmbedding,
            requestId
          ) as Promise<EmbeddingHostQueryCancellationResult>,
        queryEmbedding: (
          request: EmbeddingHostQueryEmbeddingPayload,
          options: { requestId: string }
        ) =>
          invoke(senderA, DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding, {
            payload: request,
            ...options,
          }) as Promise<BoundaryResult<number[]>>,
      },
    });
  });
  afterEach(() => {
    unregister();
    clearWindowRoleByWebContentsId(senderA.id);
    clearWindowRoleByWebContentsId(senderB.id);
    vi.useRealTimers();
  });
  function invoke(requester: Sender, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = fixture.handlers.get(channel);
    if (!handler) {
      throw new Error(`Missing query handler: ${channel}`);
    }
    return Promise.resolve(
      handler({ sender: requester, senderFrame: createAllowlistedSenderFrame() }, ...args)
    );
  }
  function requests(): EmbeddingHostQueryEmbeddingRequest[] {
    return hidden.webContents.send.mock.calls
      .map((call) => call[1] as EmbeddingHostQueryEmbeddingRequest)
      .filter((request) => request.channel === 'query-embedding');
  }
  function terminal(request: EmbeddingHostQueryEmbeddingRequest, error?: Error): void {
    manager.acceptQueryEmbeddingResponseReport(
      91,
      error
        ? createEmbeddingHostQueryEmbeddingErrorReport(request, error)
        : {
            channel: 'query-embedding-result',
            payload: { embedding: vector },
            requestId: request.requestId,
            runtimeId: request.runtimeId,
            type: 'result',
          }
    );
  }
  function capability(): IndexSearchCapability {
    const pool = {
      candidateCount: 0,
      candidatesTruncated: false,
      embedding,
      hits: [],
      scanLimited: false,
      storeId: 'store-a',
      truncated: false,
    };
    const bridge: IndexSearchCapability = {
      coverage: vi.fn(async () => ({
        embedding,
        roots: [{ rootId: 'root-a', ...counts }],
        storeId: 'store-a',
        totals: counts,
        vectorCoverageComplete: true,
      })),
      coverageBatch: vi.fn<IndexSearchCapability['coverageBatch']>(async (requests) => {
        const status = await bridge.status();
        if (status.kind !== 'ready') {
          return { kind: 'blocked', reason: status.reason };
        }
        return {
          coverage: await Promise.all(requests.map((request) => bridge.coverage(request))),
          kind: 'current',
          status,
        };
      }),
      grep: vi.fn(async () => pool),
      rebuild: vi.fn(async () => {}),
      search: vi.fn(async () => pool),
      status: vi.fn(async () => ({
        authorizedRootIds: ['root-a'],
        embedding,
        kind: 'ready' as const,
        rootReadiness: [{ rootId: 'root-a', scanComplete: true }],
        storeId: 'store-a',
      })),
    };
    return bridge;
  }
  it.each(['cancel', 'supersede'] as const)(
    'delivers %s to the exact held manager request and joins before discarding the search',
    async (action) => {
      const bridge = capability();
      const executor = new NativeWorkspaceSearchExecutor({
        capability: bridge,
        embedQuery: (_profile, query, options) =>
          generateDesktopQueryEmbedding({ ...payload, query }, options),
        profile,
      });
      const settled = vi.fn();
      const result = executor.searchSemantic(searchRequest).then((value) => {
        settled();
        return value;
      });
      await vi.waitFor(() => expect(requests()).toHaveLength(1));
      expect(bridge.coverageBatch).toHaveBeenCalledWith([{ rootIds: ['root-a'] }]);
      const request = requests()[0];
      expect(request).toBeDefined();
      if (!request) {
        throw new Error('Query did not reach hidden inference');
      }
      if (action === 'cancel') {
        executor.cancelPendingSearch();
      } else {
        await executor.searchText(searchRequest);
      }
      await flush();
      expect(hidden.webContents.send).toHaveBeenCalledWith(
        DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbeddingCancel,
        expect.objectContaining({ requestId: request.requestId, runtimeId: request.runtimeId })
      );
      expect(settled).not.toHaveBeenCalled();
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
      terminal(request, createEmbeddingHostQueryCancellationError());
      await expect(result).resolves.toBeNull();
      expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
      expect(hidden.destroy).not.toHaveBeenCalled();
      const next = generateDesktopQueryEmbedding(payload, { signal: new AbortController().signal });
      await flush();
      terminal(requests()[1] as EmbeddingHostQueryEmbeddingRequest);
      await expect(next).resolves.toEqual(vector);
    }
  );
  it('holds renderer-destruction cancellation through terminal completion', async () => {
    const settled = vi.fn();
    const result = invoke(senderA, DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding, {
      payload,
      requestId: 'closing',
    }).catch((error: unknown) => {
      settled();
      return error;
    });
    await flush();
    senderA.emit('destroyed');
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    terminal(
      requests()[0] as EmbeddingHostQueryEmbeddingRequest,
      createEmbeddingHostQueryCancellationError()
    );
    await expect(result).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'boundary.internal' }),
        ok: false,
      })
    );
    expect(senderA.listenerCount('destroyed')).toBe(0);
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
  it('rejects replay/foreign authority and leaves the other sender request usable', async () => {
    const first = invoke(senderA, DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding, {
      payload,
      requestId: 'same-token',
    });
    const firstRejected = expect(first).resolves.toMatchObject({
      error: { code: 'boundary.internal' },
      ok: false,
    });
    await flush();
    await expect(
      invoke(senderB, DESKTOP_IPC_CHANNELS.embeddingHost.cancelQueryEmbedding, 'same-token')
    ).resolves.toEqual({ cancelled: false });
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    await expect(
      invoke(senderA, DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding, {
        payload,
        requestId: 'same-token',
      })
    ).resolves.toMatchObject({ error: { code: 'embedding.request-reused' }, ok: false });
    const second = invoke(senderB, DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding, {
      payload,
      requestId: 'same-token',
    });
    await flush();
    const cancelled = invoke(
      senderA,
      DESKTOP_IPC_CHANNELS.embeddingHost.cancelQueryEmbedding,
      'same-token'
    );
    await flush();
    const firstRequest = requests()[0] as EmbeddingHostQueryEmbeddingRequest;
    manager.acceptQueryEmbeddingResponseReport(
      92,
      createEmbeddingHostQueryEmbeddingErrorReport(
        firstRequest,
        createEmbeddingHostQueryCancellationError()
      )
    );
    await flush();
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(2);
    terminal(firstRequest, createEmbeddingHostQueryCancellationError());
    await expect(cancelled).resolves.toEqual({ cancelled: true });
    await firstRejected;
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(1);
    terminal(requests()[1] as EmbeddingHostQueryEmbeddingRequest);
    await expect(second).resolves.toEqual({ ok: true, value: vector });
    await expect(
      invoke(senderA, DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding, {
        payload,
        requestId: 'same-token',
      })
    ).resolves.toMatchObject({ error: { code: 'embedding.request-reused' }, ok: false });
    const cancel = fixture.handlers.get(DESKTOP_IPC_CHANNELS.embeddingHost.cancelQueryEmbedding);
    await expect(
      cancel?.({ sender: senderA, senderFrame: { url: 'https://foreign.invalid/' } }, 'same-token')
    ).rejects.toThrow('unrecognized sender');
    clearWindowRoleByWebContentsId(senderB.id);
    await expect(
      invoke(senderB, DESKTOP_IPC_CHANNELS.embeddingHost.cancelQueryEmbedding, 'same-token')
    ).rejects.toThrow('sender role');
  });
  it('preserves independent hidden errors after cancellation instead of classifying an AbortError name', async () => {
    const controller = new AbortController();
    const result = generateDesktopQueryEmbedding(payload, { signal: controller.signal });
    const rejected = expect(result).rejects.toBeInstanceOf(BoundaryFailureError);
    await flush();
    controller.abort(new Error('search superseded'));
    await flush();
    const failure = new Error('independent device failure');
    failure.name = 'AbortError';
    terminal(requests()[0] as EmbeddingHostQueryEmbeddingRequest, failure);
    await rejected;
    expect(manager.getPlatformStatus().pendingRequestCount).toBe(0);
  });
});
