import type { EmbeddingSet } from '@brainstrike/db';
import { useMemo } from 'react';

/**
 * Row type from live query with snake_case SQL column names.
 */
type EmbeddingSetRow = Record<string, unknown> & {
  id: string;
  // biome-ignore lint/style/useNamingConvention: SQL column name
  model_key: string;
  // biome-ignore lint/style/useNamingConvention: SQL column name
  model_id: string;
  dimensions: number;
  distance: string;
  // biome-ignore lint/style/useNamingConvention: SQL column name
  created_at: string;
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
          modelKey: row.model_key,
          modelId: row.model_id,
          dimensions: row.dimensions,
          distance: row.distance as 'cosine' | 'l2' | 'ip',
          createdAt: row.created_at,
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
