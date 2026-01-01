import type { EmbeddingSet } from '@brainstrike/db';
import { useMemo } from 'react';

/**
 * Row type from live query - IPC transforms snake_case to camelCase automatically.
 */
type EmbeddingSetRow = Record<string, unknown> & {
  id: string;
  modelKey: string;
  modelId: string;
  dimensions: number;
  distance: string;
  createdAt: string;
  name: string | null;
  description: string | null;
};

/**
 * Transforms raw embedding set rows from SQL into typed EmbeddingSet objects.
 */
export function useEmbeddingSetsData(rows: EmbeddingSetRow[]): EmbeddingSet[] {
  return useMemo<EmbeddingSet[]>(
    () =>
      rows.map((row) => {
        const set: EmbeddingSet = {
          id: row.id,
          modelKey: row.modelKey,
          modelId: row.modelId,
          dimensions: row.dimensions,
          distance: row.distance as 'cosine' | 'l2' | 'ip',
          createdAt: row.createdAt,
        };
        if (row.name) {
          set.name = row.name;
        }
        if (row.description) {
          set.description = row.description;
        }
        return set;
      }),
    [rows]
  );
}

export type { EmbeddingSetRow };
