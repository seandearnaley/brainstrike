import {
  BoundaryFailureError,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDesktopQueryEmbedding } from '../../renderer/query-embeddings';

const payload = {
  dimensions: 2,
  modelId: 'model-a',
  modelKey: 'local:model-a',
  query: 'held query',
};
const queryEmbedding = vi.fn<(...args: unknown[]) => Promise<BoundaryResult<number[]>>>();
const cancelQueryEmbedding = vi.fn<(...args: unknown[]) => Promise<{ cancelled: boolean }>>();
beforeEach(() => {
  queryEmbedding.mockReset();
  cancelQueryEmbedding.mockReset();
  Object.defineProperty(window, 'embeddingHost', {
    configurable: true,
    value: { cancelQueryEmbedding, queryEmbedding },
  });
});
describe('visible query signal adapter', () => {
  it('reconstructs a device loss after the context bridge returns plain data', async () => {
    queryEmbedding.mockResolvedValue({
      error: {
        category: 'availability',
        code: 'EMBEDDING_DEVICE_LOST',
        kind: 'fault',
        message: 'WebGPU device was lost.',
        remedy: 'Choose the model again to retry.',
      },
      ok: false,
    } as never);
    await expect(
      generateDesktopQueryEmbedding(payload, { signal: new AbortController().signal })
    ).rejects.toMatchObject({
      code: 'EMBEDDING_DEVICE_LOST',
      failure: { remedy: 'Choose the model again to retry.' },
    });
  });
  it('joins failed cancellation delivery with the physical query and preserves both failures', async () => {
    const physical = Promise.withResolvers<BoundaryResult<number[]>>();
    const deliveryFailure = new Error('Cancellation IPC failed');
    const queryFailure = new Error('Independent query failed');
    queryEmbedding.mockReturnValue(physical.promise);
    cancelQueryEmbedding.mockRejectedValue(deliveryFailure);
    const controller = new AbortController();
    const settled = vi.fn();
    const result = generateDesktopQueryEmbedding(payload, { signal: controller.signal }).catch(
      (error: unknown) => {
        settled();
        return error;
      }
    );
    controller.abort(new Error('caller stopped'));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    const token = queryEmbedding.mock.calls[0]?.[1] as { requestId: string };
    expect(cancelQueryEmbedding).toHaveBeenCalledExactlyOnceWith(token.requestId);
    physical.reject(queryFailure);
    await expect(result).resolves.toEqual(
      expect.objectContaining({
        errors: [expect.objectContaining({ failure: INTERNAL_FAULT }), deliveryFailure],
      })
    );
  });
  it('does not mask an independent AbortError when the exact main cancellation outcome is false', async () => {
    const physical = Promise.withResolvers<BoundaryResult<number[]>>();
    queryEmbedding.mockReturnValue(physical.promise);
    cancelQueryEmbedding.mockResolvedValue({ cancelled: false });
    const controller = new AbortController();
    const failure = new Error('independent backend fault');
    failure.name = 'AbortError';
    const result = generateDesktopQueryEmbedding(payload, { signal: controller.signal });
    const rejected = expect(result).rejects.toBeInstanceOf(BoundaryFailureError);
    controller.abort();
    physical.reject(failure);
    await rejected;
  });
  it('joins a racing cancellation delivery before rejecting a physically completed result', async () => {
    const physical = Promise.withResolvers<BoundaryResult<number[]>>();
    const delivery = Promise.withResolvers<{ cancelled: boolean }>();
    queryEmbedding.mockReturnValue(physical.promise);
    cancelQueryEmbedding.mockReturnValue(delivery.promise);
    const controller = new AbortController();
    const reason = new Error('superseded');
    const settled = vi.fn();
    const result = generateDesktopQueryEmbedding(payload, { signal: controller.signal }).catch(
      (error: unknown) => {
        settled();
        return error;
      }
    );
    controller.abort(reason);
    physical.resolve({ ok: true, value: [0.1, 0.2] });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    delivery.resolve({ cancelled: false });
    await expect(result).resolves.toBe(reason);
  });
  it('refuses missing cancellation and pre-aborted work before admission', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateDesktopQueryEmbedding(payload, { signal: controller.signal })
    ).rejects.toBe(controller.signal.reason);
    Object.defineProperty(window, 'embeddingHost', {
      configurable: true,
      value: { queryEmbedding },
    });
    await expect(
      generateDesktopQueryEmbedding(payload, { signal: new AbortController().signal })
    ).rejects.toThrow('capability is unavailable');
    expect(queryEmbedding).not.toHaveBeenCalled();
  });
  it('rejects a missing cancellation outcome after joining physical completion', async () => {
    const physical = Promise.withResolvers<BoundaryResult<number[]>>();
    queryEmbedding.mockReturnValue(physical.promise);
    cancelQueryEmbedding.mockResolvedValue(undefined as never);
    const controller = new AbortController();
    const settled = vi.fn();
    const result = generateDesktopQueryEmbedding(payload, { signal: controller.signal }).catch(
      (error: unknown) => {
        settled();
        return error;
      }
    );
    controller.abort(new Error('caller stopped'));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    physical.resolve({ ok: true, value: [0.1, 0.2] });
    await expect(result).resolves.toEqual(
      expect.objectContaining({
        message: 'Query cancellation returned an invalid settlement outcome.',
      })
    );
  });
});
