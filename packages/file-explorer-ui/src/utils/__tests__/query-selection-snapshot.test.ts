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
  it('creates snapshots transactionally with TTL cleanup before insert', async () => {
    const db = createMockDb([
      (sql) => {
        expect(sql).toBe('BEGIN');
        return { rows: [] };
      },
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
      (sql) => {
        expect(sql).toBe('COMMIT');
        return { rows: [] };
      },
    ]);

    const snapshotId = await createQuerySelectionSnapshot(db, ['/src/index.ts', '/src/utils.ts']);

    expect(snapshotId).toBe('snapshot-1');
  });

  it('throws when snapshot creation does not return an id', async () => {
    const db = createMockDb([
      (sql) => {
        expect(sql).toBe('BEGIN');
        return { rows: [] };
      },
      () => ({ rows: [] }),
      () => ({ rows: [] }),
      (sql) => {
        expect(sql).toBe('ROLLBACK');
        return { rows: [] };
      },
    ]);

    await expect(createQuerySelectionSnapshot(db, ['/src/index.ts'])).rejects.toThrow(
      'Selection snapshot insert did not return an id'
    );
  });

  it('rolls back when file path insertion fails after creating a snapshot row', async () => {
    const db = createMockDb([
      (sql) => {
        expect(sql).toBe('BEGIN');
        return { rows: [] };
      },
      () => ({ rows: [] }),
      () => ({ rows: [{ id: 'snapshot-1' }] }),
      () => {
        throw new Error('insert files failed');
      },
      (sql) => {
        expect(sql).toBe('ROLLBACK');
        return { rows: [] };
      },
    ]);

    await expect(createQuerySelectionSnapshot(db, ['/src/index.ts'])).rejects.toThrow(
      'insert files failed'
    );
  });

  it('serializes concurrent snapshot writes on a shared db handle', async () => {
    let activeTransaction = false;
    let nextSnapshotId = 1;
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'BEGIN') {
          expect(activeTransaction).toBe(false);
          activeTransaction = true;
          return { rows: [] };
        }

        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          expect(activeTransaction).toBe(true);
          activeTransaction = false;
          return { rows: [] };
        }

        expect(activeTransaction).toBe(true);

        if (sql.includes('INSERT INTO selection_snapshots')) {
          return { rows: [{ id: `snapshot-${nextSnapshotId++}` }] };
        }

        if (sql.includes('INSERT INTO selection_snapshot_files')) {
          expect(Array.isArray(params?.[1])).toBe(true);
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
          return { rows: [] };
        }

        return { rows: [] };
      }),
    } as unknown as DbHandle;

    await expect(
      Promise.all([
        createQuerySelectionSnapshot(db, ['/src/index.ts']),
        createQuerySelectionSnapshot(db, ['/src/utils.ts']),
      ])
    ).resolves.toEqual(['snapshot-1', 'snapshot-2']);
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
