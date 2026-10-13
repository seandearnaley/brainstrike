import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertEmbeddingHostWebGpuAdapterRequest,
  assertEmbeddingHostWebGpuAdapterResponseReport,
  createEmbeddingHostWebGpuAdapterErrorReport,
  createEmbeddingHostWebGpuAdapterRequest,
  createEmbeddingHostWebGpuAdapterResultReport,
  createWebGpuAdapterRequestChannel,
  type EmbeddingHostWebGpuAdapterRequest,
  readWebGpuAdapterResponse,
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

  it('settles a request only with the response from its own runtime', async () => {
    const sent: EmbeddingHostWebGpuAdapterRequest[] = [];
    const channel = createWebGpuAdapterRequestChannel((request) => sent.push(request), 1000);
    const request = createEmbeddingHostWebGpuAdapterRequest('runtime-1');
    const answer = channel.request(request);
    expect(sent).toEqual([request]);
    channel.accept(
      createEmbeddingHostWebGpuAdapterResultReport(
        { ...request, runtimeId: 'superseded-runtime' },
        detection
      )
    );
    expect(channel.size()).toBe(1);
    channel.accept(createEmbeddingHostWebGpuAdapterResultReport(request, detection));
    expect(readWebGpuAdapterResponse(await answer)).toEqual(detection);
  });

  it("reads the host's detection failure as an error", () => {
    const request = createEmbeddingHostWebGpuAdapterRequest('runtime-1');
    expect(() =>
      readWebGpuAdapterResponse(
        createEmbeddingHostWebGpuAdapterErrorReport(request, new Error('requestAdapter threw'))
      )
    ).toThrow('requestAdapter threw');
  });

  it('refuses a request at its deadline', async () => {
    vi.useFakeTimers();
    const channel = createWebGpuAdapterRequestChannel(() => {}, 1000);
    const silent = channel.request(createEmbeddingHostWebGpuAdapterRequest('runtime-1'));
    const refused = expect(silent).rejects.toThrow(/timed out after 1000ms/u);
    await vi.advanceTimersByTimeAsync(1000);
    await refused;
    expect(channel.size()).toBe(0);
  });
});
