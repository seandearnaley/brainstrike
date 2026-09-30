import './embedding-host-foreground-ownership-fixture';
import {
  registerEmbeddingQueueFactory,
  resetEmbeddingQueueFactory,
} from '@brainstrike/embeddings/runtime-config';
import { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import type { QueueAdapter } from '@brainstrike/queue';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  assertEmbeddingHostQueryEmbeddingRequest,
  createEmbeddingHostCommand,
} from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  commandListenerRef,
  dbHandle,
  installEmbeddingHostRuntimeFixture,
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  startEmbeddingWorkerMock,
  storeState,
} from './embedding-host-foreground-ownership-fixture';

function createRequest(requestId: string, modelId: string) {
  return assertEmbeddingHostQueryEmbeddingRequest({
    channel: 'query-embedding',
    payload: {
      dimensions: 2,
      modelId,
      modelKey: `local:${modelId}`,
      query: 'public fixture query',
    },
    requestId,
    runtimeId: 'test-runtime',
    type: 'request',
  });
}

function installRealQueryService() {
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('Worker', class {});
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  storeState.hasHydrated = true;
  dbHandle.query.mockImplementation(async (_sql: unknown, values: unknown[]) => ({
    rows: [
      {
        capabilities: { defaultDimension: 2 },
        description: '',
        id: values[0],
        name: 'Fixture model',
        parameters: {},
        providerId: 'local',
      },
    ],
  }));
  const add = vi.fn<QueueAdapter['add']>(async (task) => ({
    id: task.id,
    metadata: {
      batchSize: 1,
      device: 'webgpu',
      dimensions: 2,
      dtype: 'fp16',
      elapsedMs: 1,
      fallbackApplied: false,
      model: task.model,
    },
    type: 'result',
    vectors: [Float32Array.from([0.1, 0.2])],
  }));
  const queue: QueueAdapter = {
    add,
    addBulk: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
    isPaused: false,
    isProcessing: false,
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  registerEmbeddingQueueFactory(() => queue);
  const dispose = vi.spyOn(SimpleEmbeddingService.prototype, 'dispose');
  const initialize = vi.spyOn(SimpleEmbeddingService.prototype, 'initializeWithModel');
  onTestFinished(() => {
    resetEmbeddingQueueFactory();
    vi.restoreAllMocks();
  });
  return { add, dispose, initialize };
}

async function renderReady() {
  const view = render(<EmbeddingHostRuntime />);
  onTestFinished(() => view.unmount());
  await waitFor(() =>
    expect(reportStatusMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'running' }))
  );
  return view;
}

async function send(requestId: string, modelId: string) {
  queryEmbeddingListenerRef.current?.(createRequest(requestId, modelId));
  await waitFor(() =>
    expect(
      reportQueryEmbeddingResponseMock.mock.calls.some(([report]) => report.requestId === requestId)
    ).toBe(true)
  );
  return reportQueryEmbeddingResponseMock.mock.calls
    .map(([report]) => report)
    .find((report) => report.requestId === requestId);
}

describe('foreground service ownership with the real public service', () => {
  installEmbeddingHostRuntimeFixture();

  it('keeps a warm same-model query valid when another model request arrives in the same turn', async () => {
    const { add } = installRealQueryService();
    await renderReady();
    expect(await send('warm-a', 'model-a')).toMatchObject({
      payload: { embedding: [expect.closeTo(0.1), expect.closeTo(0.2)] },
    });
    await act(async () => {
      queryEmbeddingListenerRef.current?.(createRequest('reuse-a', 'model-a'));
      queryEmbeddingListenerRef.current?.(createRequest('switch-b', 'model-b'));
    });
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(3));
    const reuse = reportQueryEmbeddingResponseMock.mock.calls
      .map(([report]) => report)
      .find((report) => report.requestId === 'reuse-a');
    const switched = reportQueryEmbeddingResponseMock.mock.calls
      .map(([report]) => report)
      .find((report) => report.requestId === 'switch-b');
    expect(switched).toMatchObject({
      payload: { embedding: [expect.closeTo(0.1), expect.closeTo(0.2)] },
    });
    expect(reuse).toMatchObject({
      payload: { embedding: [expect.closeTo(0.1), expect.closeTo(0.2)] },
    });
    expect(add).toHaveBeenCalledTimes(3);
  });

  it('completes concurrent requests reusing the same warm model', async () => {
    const { add, initialize, dispose } = installRealQueryService();
    await renderReady();
    expect(await send('warm-a', 'model-a')).toMatchObject({ type: 'result' });
    await act(async () => {
      queryEmbeddingListenerRef.current?.(createRequest('reuse-a1', 'model-a'));
      queryEmbeddingListenerRef.current?.(createRequest('reuse-a2', 'model-a'));
    });
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(3));
    expect(
      reportQueryEmbeddingResponseMock.mock.calls.every(([report]) => report.type === 'result')
    ).toBe(true);
    expect(add).toHaveBeenCalledTimes(3);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('holds a sibling model request until the active query settles and preserves response attribution', async () => {
    const { add } = installRealQueryService();
    await renderReady();
    const head = Promise.withResolvers<Awaited<ReturnType<QueueAdapter['add']>>>();
    add.mockImplementationOnce(() => head.promise);
    queryEmbeddingListenerRef.current?.(createRequest('sibling-a', 'model-a'));
    await waitFor(() => expect(add).toHaveBeenCalledOnce());
    await act(async () => {
      queryEmbeddingListenerRef.current?.(createRequest('sibling-b', 'model-b'));
    });
    expect(add).toHaveBeenCalledOnce();
    expect(reportQueryEmbeddingResponseMock).not.toHaveBeenCalled();
    head.resolve({
      id: add.mock.calls[0]![0].id,
      metadata: {
        batchSize: 1,
        device: 'webgpu',
        dimensions: 2,
        dtype: 'fp16',
        elapsedMs: 1,
        fallbackApplied: false,
        model: 'model-a',
      },
      type: 'result',
      vectors: [Float32Array.from([0.3, 0.4])],
    });
    await waitFor(() => expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledTimes(2));
    expect(add.mock.calls.map(([task]) => task.model)).toEqual(['model-a', 'model-b']);
    expect(
      reportQueryEmbeddingResponseMock.mock.calls.map(([report]) => [
        report.requestId,
        report.payload.embedding,
      ])
    ).toEqual([
      ['sibling-a', [expect.closeTo(0.3), expect.closeTo(0.4)]],
      ['sibling-b', [expect.closeTo(0.1), expect.closeTo(0.2)]],
    ]);
  });

  it('fails closed when cached service disposal fails during a model switch', async () => {
    const { add, dispose, initialize } = installRealQueryService();
    await renderReady();
    expect(await send('warm-a', 'model-a')).toMatchObject({ type: 'result' });
    dispose.mockRejectedValueOnce(new Error('Fixture service disposal failed.'));
    expect(await send('switch-b', 'model-b')).toMatchObject({
      payload: { message: 'Fixture service disposal failed.' },
      type: 'error',
    });
    expect(await send('after-failure', 'model-c')).toMatchObject({
      payload: { message: 'Embedding host query runtime is unavailable.' },
      type: 'error',
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(reportStatusMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        active: false,
        lastError: 'Fixture service disposal failed.',
        state: 'error',
      })
    );
  });

  it('completes sequential model changes using the same real service path', async () => {
    const { add } = installRealQueryService();
    await renderReady();
    for (const [id, model] of [
      ['warm-a', 'model-a'],
      ['reuse-a', 'model-a'],
      ['switch-b', 'model-b'],
    ]) {
      expect(await send(id!, model!)).toMatchObject({
        payload: { embedding: [expect.closeTo(0.1), expect.closeTo(0.2)] },
      });
    }
    expect(add).toHaveBeenCalledTimes(3);
  });
  it.each(['before', 'after'] as const)(
    'does not restore an old failed disposal %s a reset generation warms',
    async (timing) => {
      const { dispose, initialize } = installRealQueryService();
      await renderReady();
      expect(await send('warm-a', 'model-a')).toMatchObject({ type: 'result' });
      const oldDisposal = Promise.withResolvers<void>();
      dispose.mockImplementationOnce(() => oldDisposal.promise);
      queryEmbeddingListenerRef.current?.(createRequest('old-switch-b', 'model-b'));
      await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      commandListenerRef.current?.(
        createEmbeddingHostCommand('reset', 'test-runtime', 'next-runtime')
      );
      await waitFor(() => expect(startEmbeddingWorkerMock).toHaveBeenCalledTimes(2));
      const replacementModel = timing === 'before' ? 'model-a' : 'model-b';
      const sendNew = async (id: string) => {
        queryEmbeddingListenerRef.current?.({
          ...createRequest(id, replacementModel),
          runtimeId: 'next-runtime',
        });
        await waitFor(() =>
          expect(
            reportQueryEmbeddingResponseMock.mock.calls.some(([r]) => r.requestId === id)
          ).toBe(true)
        );
        return reportQueryEmbeddingResponseMock.mock.calls.find(([r]) => r.requestId === id)?.[0];
      };
      if (timing === 'after') {
        expect(await sendNew('new-warm-b')).toMatchObject({ type: 'result' });
        expect(initialize).toHaveBeenCalledTimes(2);
      }
      oldDisposal.reject(new Error('Old disposal rejected after reset.'));
      await waitFor(() =>
        expect(
          reportQueryEmbeddingResponseMock.mock.calls.some(([r]) => r.requestId === 'old-switch-b')
        ).toBe(true)
      );
      expect(
        reportQueryEmbeddingResponseMock.mock.calls.find(
          ([report]) => report.requestId === 'old-switch-b'
        )?.[0]
      ).toMatchObject({
        payload: { message: 'Old disposal rejected after reset.' },
        type: 'error',
      });
      if (timing === 'before') {
        expect(await sendNew('new-warm-b')).toMatchObject({ type: 'result' });
      }
      expect(await sendNew('new-reuse-b')).toMatchObject({ type: 'result' });
      expect(initialize).toHaveBeenCalledTimes(2);
    }
  );
});
