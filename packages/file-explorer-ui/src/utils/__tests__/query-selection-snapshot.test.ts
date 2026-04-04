import type { DbHandle } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';

import {
  createQuerySelectionSnapshot,
  loadQuerySelectionSnapshot,
} from '../query-selection-snapshot';

function createMockDb(
  implementations: Array<(sql: string, params?: unknown[]) => unknown>
): DbHandle {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const implementation = implementations.shift();
    if (!implementation) {
      throw new Error(`Unexpected query: ${sql}`);
    }
    return implementation(sql, params);
  });

  return {
    query,
  } as unknown as DbHandle;
}

describe('query-selection-snapshot', () => {
  it('creates snapshots with TTL cleanup before insert', async () => {
    const db = createMockDb([
      (sql) => {
        expect(sql).toContain('DELETE FROM selection_snapshots');
        expect(sql).toContain('expires_at <= NOW()');
        return { rows: [] };
      },
      (sql, params) => {
        expect(sql).toContain('INSERT INTO selection_snapshots');
        expect(sql).toContain("INTERVAL '1 hour'");
        expect(params).toEqual([24]);
        return { rows: [{ id: 'snapshot-1' }] };
      },
      (sql, params) => {
        expect(sql).toContain('INSERT INTO selection_snapshot_files');
        expect(params).toEqual(['snapshot-1', ['/src/index.ts', '/src/utils.ts']]);
        return { rows: [] };
      },
    ]);

    const snapshotId = await createQuerySelectionSnapshot(db, ['/src/index.ts', '/src/utils.ts']);

    expect(snapshotId).toBe('snapshot-1');
  });

  it('throws when snapshot creation does not return an id', async () => {
    const db = createMockDb([() => ({ rows: [] }), () => ({ rows: [] })]);

    await expect(createQuerySelectionSnapshot(db, ['/src/index.ts'])).rejects.toThrow(
      'Selection snapshot insert did not return an id'
    );
  });

  it('loads only non-expired snapshot rows', async () => {
    const db = createMockDb([
      (sql, params) => {
        expect(sql).toContain('JOIN selection_snapshots ss');
        expect(sql).toContain('ss.expires_at > NOW()');
        expect(params).toEqual(['snapshot-1']);
        return {
          rows: [{ file_path: '/src/utils.ts' }, { file_path: '/src/index.ts' }],
        };
      },
    ]);

    await expect(loadQuerySelectionSnapshot(db, 'snapshot-1')).resolves.toEqual([
      '/src/index.ts',
      '/src/utils.ts',
    ]);
  });
});
