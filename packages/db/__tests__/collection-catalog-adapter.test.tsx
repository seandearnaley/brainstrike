// @vitest-environment jsdom

import type { CollectionCatalogCapability } from '@brainstrike/assistant-contract';
import { renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useEmbeddingSetsRepository } from '../src/use-db';

afterEach(() => vi.unstubAllGlobals());

test('desktop collection consumers use the authoritative capability without a database provider', async () => {
  const item = {
    createdAt: '2026-10-13T20:00:00.000Z',
    dimensions: 384,
    distance: 'cosine' as const,
    id: 'original-id',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    modelKey: 'local::Xenova/all-MiniLM-L6-v2',
  };
  const catalog: CollectionCatalogCapability = {
    create: vi.fn(async () => item),
    delete: vi.fn(async () => true),
    ensureWorkspaceIndex: vi.fn(async () => item),
    get: vi.fn(async () => item),
    list: vi.fn(async () => [item]),
    update: vi.fn(async () => item),
  };
  vi.stubGlobal('collectionCatalog', catalog);
  const { result } = renderHook(useEmbeddingSetsRepository);
  expect(result.current).not.toBeNull();
  expect(await result.current?.findAll()).toEqual([item]);
  expect(await result.current?.getByModelKey(item.modelKey)).toEqual([item]);
  expect(
    await result.current?.getOrCreateSet(item.modelKey, item.modelId, 384, 'cosine', {
      name: 'My collection',
    })
  ).toEqual(item);
  expect(catalog.create).toHaveBeenCalledWith({
    dimensions: 384,
    distance: 'cosine',
    metadata: { name: 'My collection' },
    modelId: item.modelId,
    modelKey: item.modelKey,
  });
  await result.current?.delete(item.id);
  expect(catalog.delete).toHaveBeenCalledWith(item.id);
  vi.mocked(catalog.list).mockRejectedValueOnce(new Error('writer unavailable'));
  await expect(result.current?.findAll()).rejects.toThrow('writer unavailable');
});
