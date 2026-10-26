// @vitest-environment jsdom
import {
  BoundaryFailureError,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_EMBEDDING_REFUSALS } from '../../hosted-embedding-error';
import { generateDesktopQueryEmbedding } from '../../renderer/query-embeddings';

const request = {
  dimensions: 1536,
  modelId: 'text-embedding-3-small',
  modelKey: 'openai::text-embedding-3-small',
  query: 'held query',
};
const embedQuery = vi.fn<(...args: unknown[]) => Promise<BoundaryResult<number[]>>>();
beforeEach(() => {
  embedQuery.mockReset();
  Object.defineProperty(window, 'indexSearch', {
    configurable: true,
    value: { embedQuery },
  });
});
describe('visible query embedding adapter', () => {
  it("returns Main's embedding of the query with the index's hosted model", async () => {
    embedQuery.mockResolvedValue({ ok: true, value: [0.1, 0.2] });
    await expect(
      generateDesktopQueryEmbedding(request, { signal: new AbortController().signal })
    ).resolves.toEqual([0.1, 0.2]);
    expect(embedQuery).toHaveBeenCalledExactlyOnceWith(request);
  });
  it('reconstructs a provider refusal after the context bridge returns plain data', async () => {
    embedQuery.mockResolvedValue({ error: HOSTED_EMBEDDING_REFUSALS['missing-key'], ok: false });
    await expect(
      generateDesktopQueryEmbedding(request, { signal: new AbortController().signal })
    ).rejects.toMatchObject({
      code: 'embedding.missing-key',
      failure: { remedy: HOSTED_EMBEDDING_REFUSALS['missing-key'].remedy },
    });
  });
  it('reports a failed transport as an internal fault, never Electron prose', async () => {
    embedQuery.mockRejectedValue(new Error("Error invoking remote method 'brainstrike:invoke'"));
    const result = generateDesktopQueryEmbedding(request, {
      signal: new AbortController().signal,
    });
    await expect(result).rejects.toBeInstanceOf(BoundaryFailureError);
    await expect(result).rejects.toMatchObject({ failure: INTERNAL_FAULT });
  });
  it('drops the answer of a search aborted while Main embedded it', async () => {
    const answer = Promise.withResolvers<BoundaryResult<number[]>>();
    embedQuery.mockReturnValue(answer.promise);
    const controller = new AbortController();
    const reason = new Error('superseded');
    const result = generateDesktopQueryEmbedding(request, { signal: controller.signal });
    controller.abort(reason);
    answer.resolve({ ok: true, value: [0.1, 0.2] });
    await expect(result).rejects.toBe(reason);
  });
  it('refuses pre-aborted work and a missing capability before calling Main', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateDesktopQueryEmbedding(request, { signal: controller.signal })
    ).rejects.toBe(controller.signal.reason);
    Object.defineProperty(window, 'indexSearch', { configurable: true, value: undefined });
    await expect(
      generateDesktopQueryEmbedding(request, { signal: new AbortController().signal })
    ).rejects.toThrow('capability is unavailable');
    expect(embedQuery).not.toHaveBeenCalled();
  });
});
