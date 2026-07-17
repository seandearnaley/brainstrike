import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EmbeddingSetRow } from '../use-embedding-sets-data';
import { useEmbeddingSetsData } from '../use-embedding-sets-data';

const mockRows: EmbeddingSetRow[] = [
  {
    created_at: '2025-01-01T00:00:00Z',
    description: 'Description 1',
    dimensions: 1536,
    distance: 'cosine',
    id: '1',
    model_id: 'text-embedding-3-small',
    model_key: 'openai::text-embedding-3-small',
    name: 'Collection 1',
  },
  {
    created_at: '2025-01-02T00:00:00Z',
    description: null,
    dimensions: 1024,
    distance: 'l2',
    id: '2',
    model_id: 'bge-m3',
    model_key: 'local::Xenova/bge-m3',
    name: null,
  },
];

describe('useEmbeddingSetsData', () => {
  it('should transform SQL rows into EmbeddingSet objects', () => {
    const { result } = renderHook(() => useEmbeddingSetsData(mockRows));

    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toEqual({
      createdAt: '2025-01-01T00:00:00Z',
      description: 'Description 1',
      dimensions: 1536,
      distance: 'cosine',
      id: '1',
      modelId: 'text-embedding-3-small',
      modelKey: 'openai::text-embedding-3-small',
      name: 'Collection 1',
    });
    expect(result.current[1]).toEqual({
      createdAt: '2025-01-02T00:00:00Z',
      dimensions: 1024,
      distance: 'l2',
      id: '2',
      modelId: 'bge-m3',
      modelKey: 'local::Xenova/bge-m3',
    });
  });

  it('should handle empty rows', () => {
    const { result } = renderHook(() => useEmbeddingSetsData([]));
    expect(result.current).toEqual([]);
  });
});
