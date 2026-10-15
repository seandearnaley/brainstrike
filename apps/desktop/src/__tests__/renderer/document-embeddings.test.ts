// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDesktopDocumentEmbeddings } from '../../renderer/document-embeddings';

const payload = {
  dimensions: 384,
  inferencePlan: {
    device: 'wasm' as const,
    dimensions: 384 as const,
    dtype: 'q8' as const,
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  },
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'native:docs',
  texts: ['document'],
};
const documentEmbeddings = vi.fn<(...args: unknown[]) => Promise<number[][]>>();
const cancelDocumentEmbeddings = vi.fn<(...args: unknown[]) => Promise<void>>();
beforeEach(() => {
  documentEmbeddings.mockReset();
  cancelDocumentEmbeddings.mockReset().mockResolvedValue();
  Object.defineProperty(window, 'embeddingHost', {
    configurable: true,
    value: { cancelDocumentEmbeddings, documentEmbeddings },
  });
});
describe('renderer document signal adapter', () => {
  it('keeps AbortSignal out of the context bridge and preserves order', async () => {
    const vectors = [Array.from({ length: 384 }, () => 0.1)];
    documentEmbeddings.mockResolvedValue(vectors);
    const controller = new AbortController();
    await expect(
      generateDesktopDocumentEmbeddings(payload, { signal: controller.signal })
    ).resolves.toEqual(vectors);
    expect(documentEmbeddings).toHaveBeenCalledWith(payload, { requestId: expect.any(String) });
    controller.abort();
    expect(cancelDocumentEmbeddings).not.toHaveBeenCalled();
  });
  it('propagates cancellation with the exact submitted token', async () => {
    const pending = Promise.withResolvers<number[][]>();
    documentEmbeddings.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const result = generateDesktopDocumentEmbeddings(payload, { signal: controller.signal });
    const reason = new Error('owner canceled');
    const rejected = expect(result).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    const token = documentEmbeddings.mock.calls[0]?.[1] as { requestId: string };
    expect(cancelDocumentEmbeddings).toHaveBeenCalledExactlyOnceWith(token.requestId);
    pending.resolve([Array.from({ length: 384 }, () => 0.1)]);
  });
  it('surfaces undeliverable cancellation', async () => {
    documentEmbeddings.mockReturnValue(new Promise(() => {}));
    cancelDocumentEmbeddings.mockRejectedValue(new Error('IPC unavailable'));
    const controller = new AbortController();
    const result = generateDesktopDocumentEmbeddings(payload, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow('IPC unavailable');
    controller.abort();
    await rejected;
  });
  it('does not hide cancellation delivery failure when a result races the abort', async () => {
    const pending = Promise.withResolvers<number[][]>();
    const delivery = Promise.withResolvers<void>();
    documentEmbeddings.mockReturnValue(pending.promise);
    cancelDocumentEmbeddings.mockReturnValue(delivery.promise);
    const controller = new AbortController();
    const result = generateDesktopDocumentEmbeddings(payload, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow('delivery failed');
    controller.abort(new Error('caller stopped'));
    pending.resolve([Array.from({ length: 384 }, () => 0.1)]);
    delivery.reject(new Error('delivery failed'));
    await rejected;
  });
  it('refuses pre-aborted work before transport', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateDesktopDocumentEmbeddings(payload, { signal: controller.signal })
    ).rejects.toThrow();
    expect(documentEmbeddings).not.toHaveBeenCalled();
  });
});
