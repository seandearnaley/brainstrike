import { describe, expect, it } from 'vitest';
import {
  type CanvasReadDatabase,
  getCanvasVersion,
  listThreadCanvasSummaries,
} from '../canvas/canvas-read-repository';

interface QueryCall {
  readonly params: readonly unknown[] | undefined;
  readonly sql: string;
}

function createFakeDatabase(
  rows: readonly unknown[]
): CanvasReadDatabase & { readonly calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    query: async <T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> => {
      calls.push({ params, sql });
      return { rows: [...rows] as T[] };
    },
  };
}

describe('canvas read repository', () => {
  it('lists thread summaries newest-first without html (summaries, not documents)', async () => {
    const summary = {
      canvasId: 'canvas-1',
      createdAt: '2026-08-07 01:00:00+00',
      latestVersion: 3,
      title: 'Chart',
    };
    const db = createFakeDatabase([summary]);

    await expect(listThreadCanvasSummaries(db, 'thread-1')).resolves.toEqual([summary]);
    const call = db.calls[0];
    expect(call?.params).toEqual(['thread-1']);
    expect(call?.sql).toMatch(/DISTINCT ON \(canvas_id\)/i);
    expect(call?.sql).toContain('created_at::text');
    expect(call?.sql).not.toMatch(/html/i);
  });

  it('reads one exact version with a text-cast timestamp, null when absent', async () => {
    const version = {
      createdAt: '2026-08-07 01:00:00+00',
      createdBy: 'assistant',
      html: '<p>v2</p>',
      version: 2,
    };
    const db = createFakeDatabase([version]);
    await expect(getCanvasVersion(db, 'canvas-1', 2)).resolves.toEqual(version);
    expect(db.calls[0]?.params).toEqual(['canvas-1', 2]);
    expect(db.calls[0]?.sql).toContain('created_at::text');

    const empty = createFakeDatabase([]);
    await expect(getCanvasVersion(empty, 'canvas-1', 99)).resolves.toBeNull();
  });
});
