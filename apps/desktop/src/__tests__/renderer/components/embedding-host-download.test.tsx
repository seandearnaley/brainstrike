import './embedding-host-foreground-ownership-fixture';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createEmbeddingHostCommand,
  createEmbeddingHostDownloadRequest,
} from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  commandListenerRef,
  installEmbeddingHostRuntimeFixture,
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  storeState,
} from './embedding-host-foreground-ownership-fixture';

class OwnedWorker {
  static readonly instances: OwnedWorker[] = [];
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  constructor(_url: string, _options: WorkerOptions) {
    OwnedWorker.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') {
      this.listeners.add(listener);
    }
  }
  removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') {
      this.listeners.delete(listener);
    }
  }
  emit(data: unknown): void {
    for (const listener of this.listeners) {
      listener({ data } as MessageEvent<unknown>);
    }
  }
}

async function mountReadyHost() {
  OwnedWorker.instances.length = 0;
  vi.stubGlobal('Worker', OwnedWorker);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  storeState.hasHydrated = true;
  const mounted = render(<EmbeddingHostRuntime />);
  await waitFor(() =>
    expect(reportStatusMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'running' }))
  );
  return mounted;
}

function requestDownload(requestId: string) {
  act(() =>
    queryEmbeddingListenerRef.current?.(
      createEmbeddingHostDownloadRequest('test-runtime', { modelId: 'model-a', requestId })
    )
  );
}

async function activeDownloadWorker(index = 0): Promise<OwnedWorker> {
  await waitFor(() => expect(OwnedWorker.instances).toHaveLength(index + 1));
  const worker = OwnedWorker.instances[index];
  if (!worker) {
    throw new Error('Missing owned download worker');
  }
  await waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'download-model' })
    )
  );
  return worker;
}

function workerRequestId(worker: OwnedWorker): string {
  const message: unknown = worker.postMessage.mock.calls[0]?.[0];
  if (!message) {
    throw new Error('Download request was not posted');
  }
  return (message as { request: { id: string } }).request.id;
}

describe('hidden-host owned model download', () => {
  installEmbeddingHostRuntimeFixture();

  it('uses the real service/worker client, serializes repeats, and releases each worker before completion', async () => {
    const mounted = await mountReadyHost();
    requestDownload('download-a');
    requestDownload('download-b');
    const first = await activeDownloadWorker();
    expect(OwnedWorker.instances).toHaveLength(1);
    act(() => first.emit({ id: workerRequestId(first), progress: 99, type: 'download-progress' }));
    expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'download-progress',
        payload: { progress: 99 },
        requestId: 'download-a',
      })
    );
    expect(reportQueryEmbeddingResponseMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'download-complete' })
    );
    act(() => first.emit({ id: workerRequestId(first), type: 'download-complete' }));
    await waitFor(() =>
      expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'download-complete', requestId: 'download-a' })
      )
    );
    expect(first.terminate).toHaveBeenCalledOnce();
    const second = await activeDownloadWorker(1);
    act(() =>
      second.emit({
        id: workerRequestId(second),
        message: 'session release failed',
        type: 'download-error',
      })
    );
    await waitFor(() =>
      expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ message: 'session release failed' }),
          requestId: 'download-b',
          type: 'error',
        })
      )
    );
    expect(second.terminate).toHaveBeenCalledOnce();
    expect(reportQueryEmbeddingResponseMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'download-complete', requestId: 'download-b' })
    );
    mounted.unmount();
  });

  it.each(['stop', 'reset'] as const)(
    'terminates the active worker and rejects queued work before %s acknowledgement',
    async (action) => {
      const mounted = await mountReadyHost();
      requestDownload('download-a');
      requestDownload('download-b');
      const worker = await activeDownloadWorker();
      const command =
        action === 'stop'
          ? createEmbeddingHostCommand('stop', 'test-runtime')
          : createEmbeddingHostCommand('reset', 'test-runtime', 'replacement-runtime');
      act(() => commandListenerRef.current?.(command));
      await waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(reportStatusMock).toHaveBeenCalledWith(
          expect.objectContaining(
            action === 'stop'
              ? { commandId: command.requestId, state: 'stopped' }
              : { runtimeId: 'replacement-runtime', state: 'running' }
          )
        )
      );
      expect(OwnedWorker.instances).toHaveLength(1);
      expect(worker.listeners.size).toBe(0);
      expect(reportQueryEmbeddingResponseMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'download-complete' })
      );
      await waitFor(() =>
        expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
          expect.objectContaining({ requestId: 'download-b', type: 'error' })
        )
      );
      mounted.unmount();
    }
  );
});
