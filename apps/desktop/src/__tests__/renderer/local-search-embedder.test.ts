// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { createDesktopLocalSearchEmbedder } from '../../renderer/local-search-embedder';

const model = {
  description: '',
  dimensions: 384,
  id: 'Xenova/all-MiniLM-L6-v2',
  name: 'MiniLM',
  tags: [],
};
const vector = new Array<number>(384).fill(0.1);
afterEach(() => Reflect.deleteProperty(window, 'embeddingHost'));

test('desktop search query and document requests share the exact hidden-host profile', async () => {
  const queryEmbedding = vi.fn(async () => ({ ok: true, value: vector }));
  const documentEmbeddings = vi.fn(async () => [vector]);
  Object.defineProperty(window, 'embeddingHost', {
    configurable: true,
    value: {
      cancelDocumentEmbeddings: vi.fn(),
      cancelQueryEmbedding: vi.fn(),
      documentEmbeddings,
      queryEmbedding,
    },
  });
  const embedder = await createDesktopLocalSearchEmbedder(model, 'wasm');
  await expect(embedder.embedQuery('acknowledged')).resolves.toEqual({ embedding: vector });
  await expect(embedder.embedDocument('Noted.')).resolves.toEqual({ embedding: vector });
  const identity = {
    dimensions: 384,
    inferencePlan: {
      device: 'wasm',
      dimensions: 384,
      dtype: 'q4',
      modelId: model.id,
    },
    modelId: model.id,
    modelKey: `local::${model.id}`,
  };
  expect(queryEmbedding).toHaveBeenCalledExactlyOnceWith(
    { ...identity, query: 'acknowledged' },
    { requestId: expect.any(String) }
  );
  expect(documentEmbeddings).toHaveBeenCalledExactlyOnceWith(
    { ...identity, texts: ['Noted.'] },
    { requestId: expect.any(String) }
  );
  expect(embedder.runtime).toBe('wasm');
});

test('missing hidden inference refuses instead of constructing a browser worker', async () => {
  const embedder = await createDesktopLocalSearchEmbedder(model, 'wasm');
  await expect(embedder.embedQuery('query')).rejects.toThrow('inference capability is unavailable');
  await expect(embedder.embedDocument('document')).rejects.toThrow(
    'embedding capability is unavailable'
  );
});
