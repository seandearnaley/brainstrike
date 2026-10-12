import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertEmbeddingHostWebGpuAdapterRequest,
  assertEmbeddingHostWebGpuAdapterResponseReport,
  createEmbeddingHostWebGpuAdapterErrorReport,
  createEmbeddingHostWebGpuAdapterRequest,
  createEmbeddingHostWebGpuAdapterResultReport,
  EmbeddingHostWebGpuAdapterRequests,
} from '../embedding-host-webgpu-adapter';

const detection = { available: false, reason: 'WASM fallback (WebGPU not available)' };

describe('embedding host WebGPU adapter exchange (BST-1993)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('decodes exact requests and responses and refuses anything else', () => {
    const request = createEmbeddingHostWebGpuAdapterRequest('runtime-1');
    expect(assertEmbeddingHostWebGpuAdapterRequest(request)).toEqual(request);
    expect(() =>
      assertEmbeddingHostWebGpuAdapterRequest({ ...request, payload: { x: 1 } })
    ).toThrow('carries no payload');
    const result = createEmbeddingHostWebGpuAdapterResultReport(request, detection);
    expect(assertEmbeddingHostWebGpuAdapterResponseReport(result)).toEqual(result);
    for (const payload of [
      { available: 'no', reason: 'x' },
      { available: false },
      { available: false, reason: ' ' },
      { available: false, extra: 1, reason: 'x' },
    ]) {
      expect(() => assertEmbeddingHostWebGpuAdapterResponseReport({ ...result, payload })).toThrow(
        'exactly { available: boolean, reason: string }'
      );
    }
    const error = createEmbeddingHostWebGpuAdapterErrorReport(request, new Error('GPU lost'));
    expect(assertEmbeddingHostWebGpuAdapterResponseReport(error)).toMatchObject({
      payload: { message: 'GPU lost' },
      type: 'error',
    });
  });

  it('settles a request only with its exact response', async () => {
    const requests = new EmbeddingHostWebGpuAdapterRequests();
    const sent: ReturnType<typeof createEmbeddingHostWebGpuAdapterRequest>[] = [];
    const answer = requests.request('runtime-1', (request) => sent.push(request), 1000);
    const [request] = sent;
    if (!request) {
      throw new Error('Expected the request to be sent');
    }
    requests.accept(
      createEmbeddingHostWebGpuAdapterResultReport(
        { ...request, runtimeId: 'superseded-runtime' },
        detection
      )
    );
    requests.accept(createEmbeddingHostWebGpuAdapterResultReport(request, detection));
    await expect(answer).resolves.toEqual(detection);
  });

  it('refuses a host that never answers and one that did not start', async () => {
    vi.useFakeTimers();
    const requests = new EmbeddingHostWebGpuAdapterRequests();
    const silent = requests.request('runtime-1', () => {}, 1000);
    vi.advanceTimersByTime(1000);
    await expect(silent).rejects.toThrow('did not report WebGPU availability in 1000 ms');
    await expect(
      requests.detect(
        async () => ({ lastError: 'host crashed', runtimeId: 'runtime-1', state: 'error' }),
        () => {},
        1000
      )
    ).rejects.toThrow('host crashed');
  });
});
