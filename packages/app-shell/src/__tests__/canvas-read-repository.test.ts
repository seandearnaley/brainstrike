import { describe, expect, it } from 'vitest';
import {
  type CanvasReadDatabase,
  getCanvasVersion,
  listThreadCanvasSummaries,
  readThreadCanvasSummaries,
  readThreadCanvasVersion,
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

  it('reads a host-owned thread from its host, and history only for threads the host does not own', async () => {
    const plan = (version: number, createdAt: string) => ({
      canvasId: 'plan',
      createdAt,
      createdBy: 'assistant',
      html: `<p>plan v${version}</p>`,
      title: `Plan v${version}`,
      version,
    });
    const notes = {
      canvasId: 'notes',
      createdAt: '2026-10-08T10:00:00.000Z',
      createdBy: 'user',
      html: '<p>notes</p>',
      title: 'Notes',
      version: 1,
    };
    const host = {
      readCanvases: async (threadId: string) =>
        threadId === 'host-thread'
          ? new Map([
              ['plan', [plan(1, '2026-10-08T09:00:00.000Z'), plan(2, '2026-10-08T11:00:00.000Z')]],
              ['notes', [notes]],
            ])
          : undefined,
    };
    const db = createFakeDatabase([]);

    await expect(readThreadCanvasSummaries(db, host, 'host-thread')).resolves.toEqual([
      {
        canvasId: 'plan',
        createdAt: '2026-10-08T11:00:00.000Z',
        latestVersion: 2,
        title: 'Plan v2',
      },
      {
        canvasId: 'notes',
        createdAt: '2026-10-08T10:00:00.000Z',
        latestVersion: 1,
        title: 'Notes',
      },
    ]);
    await expect(readThreadCanvasVersion(db, host, 'host-thread', 'plan', 1)).resolves.toEqual({
      createdAt: '2026-10-08T09:00:00.000Z',
      createdBy: 'assistant',
      html: '<p>plan v1</p>',
      version: 1,
    });
    await expect(readThreadCanvasVersion(db, host, 'host-thread', 'plan', 3)).resolves.toBeNull();
    expect(db.calls).toEqual([]);

    await expect(readThreadCanvasSummaries(db, host, 'legacy-thread')).resolves.toEqual([]);
    await expect(readThreadCanvasVersion(db, host, 'legacy-thread', 'plan', 1)).resolves.toBeNull();
    expect(db.calls.map((call) => call.params)).toEqual([['legacy-thread'], ['plan', 1]]);
  });
});
