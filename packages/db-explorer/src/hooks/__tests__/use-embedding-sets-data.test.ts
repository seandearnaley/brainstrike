import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EmbeddingSetRow } from '../use-embedding-sets-data';
import { useEmbeddingSetsData } from '../use-embedding-sets-data';

const mockRows: EmbeddingSetRow[] = [
  {
    id: '1',
    model_key: 'openai::text-embedding-3-small',
    model_id: 'text-embedding-3-small',
    dimensions: 1536,
    distance: 'cosine',
    created_at: '2025-01-01T00:00:00Z',
    name: 'Collection 1',
    description: 'Description 1',
  },
  {
    id: '2',
    model_key: 'local::Xenova/bge-m3',
    model_id: 'bge-m3',
    dimensions: 1024,
    distance: 'l2',
    created_at: '2025-01-02T00:00:00Z',
    name: null,
    description: null,
  },
];

describe('useEmbeddingSetsData', () => {
  it('should transform SQL rows into EmbeddingSet objects', () => {
    const { result } = renderHook(() => useEmbeddingSetsData(mockRows));

    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toEqual({
      id: '1',
      modelKey: 'openai::text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
      distance: 'cosine',
      createdAt: '2025-01-01T00:00:00Z',
      name: 'Collection 1',
      description: 'Description 1',
    });
    expect(result.current[1]).toEqual({
      id: '2',
      modelKey: 'local::Xenova/bge-m3',
      modelId: 'bge-m3',
      dimensions: 1024,
      distance: 'l2',
      createdAt: '2025-01-02T00:00:00Z',
    });
  });

  it('should handle empty rows', () => {
    const { result } = renderHook(() => useEmbeddingSetsData([]));
    expect(result.current).toEqual([]);
  });
});
