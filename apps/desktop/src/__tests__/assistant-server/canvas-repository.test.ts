import { describe, expect, it } from 'vitest';
import {
  applyUpdate,
  type CanvasDatabase,
  type CanvasVersion,
  createCanvas,
  getLatestVersion,
  listCanvasesForThread,
  rewriteCanvas,
} from '../../assistant-server/canvas-repository';

interface QueryCall {
  readonly params: readonly unknown[] | undefined;
  readonly sql: string;
}

function versionRow(overrides: Partial<CanvasVersion> = {}): CanvasVersion {
  return {
    canvasId: 'canvas-1',
    createdAt: '2026-08-06 12:34:56.123456+00',
    createdBy: 'assistant',
    html: '<p>Hello world</p>',
    id: 'version-1',
    resourceId: 'resource-1',
    threadId: 'thread-1',
    title: 'Draft',
    version: 1,
    ...overrides,
  };
}

function createFakeDatabase(
  handler: (call: QueryCall, index: number) => readonly unknown[]
): CanvasDatabase & { readonly calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    query: async <T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> => {
      const call = { params, sql };
      calls.push(call);
      return { rows: [...handler(call, calls.length - 1)] as T[] };
    },
  };
}

describe('canvas repository', () => {
  it('creates version one with app-side uuidv7 ids and exact SQL parameters', async () => {
    const db = createFakeDatabase(({ params, sql }) => {
      expect(sql).toMatch(/INSERT INTO brainstrike_canvas_versions/i);
      expect(sql).toMatch(/RETURNING/i);
      return [{ canvasId: params?.[1], version: 1 }];
    });

    const result = await createCanvas(db, {
      createdBy: 'user',
      html: '<main>Hello</main>',
      resourceId: 'resource-1',
      threadId: 'thread-1',
      title: 'Welcome',
    });

    expect(result).toEqual({
      canvasId: expect.stringMatching(/^[0-9a-f-]+$/),
      version: 1,
    });
    const params = db.calls[0]?.params;
    expect(params?.[0]).toEqual(expect.stringMatching(/^[0-9a-f-]+$/));
    expect(params?.[1]).toBe(result.canvasId);
    expect(params?.[0]).not.toBe(params?.[1]);
    expect(params?.slice(2)).toEqual([
      'thread-1',
      'resource-1',
      'Welcome',
      '<main>Hello</main>',
      1,
      'user',
    ]);
  });

  it('reads the latest version with a text-cast timestamp and validates created_by', async () => {
    const db = createFakeDatabase(({ sql, params }) => {
      expect(sql).toContain('created_at::text AS "createdAt"');
      expect(sql).toMatch(/ORDER BY version DESC/i);
      expect(params).toEqual(['canvas-1']);
      return [versionRow()];
    });

    await expect(getLatestVersion(db, 'canvas-1')).resolves.toEqual(versionRow());

    const corrupt = createFakeDatabase(() => [versionRow({ createdBy: 'system' as 'assistant' })]);
    await expect(getLatestVersion(corrupt, 'canvas-1')).rejects.toThrow(/created_by|creator/i);
  });

  it('returns a structured not_found result when the canvas has no versions', async () => {
    const db = createFakeDatabase(() => []);
    await expect(getLatestVersion(db, 'missing')).resolves.toEqual({
      error: 'not_found',
      ok: false,
    });
  });

  it('applies an exact single replacement into a new assistant-authored version', async () => {
    const db = createFakeDatabase(({ params }, index) => {
      if (index === 0) {
        return [versionRow({ version: 3 })];
      }
      return [{ canvasId: params?.[1], version: params?.[6] }];
    });

    await expect(
      applyUpdate(db, { canvasId: 'canvas-1', newString: 'Canvas', oldString: 'world' })
    ).resolves.toEqual({ canvasId: 'canvas-1', version: 4 });

    expect(db.calls).toHaveLength(2);
    expect(db.calls[1]?.params?.slice(1)).toEqual([
      'canvas-1',
      'thread-1',
      'resource-1',
      'Draft',
      '<p>Hello Canvas</p>',
      4,
      'assistant',
    ]);
  });

  it('returns no_match without inserting when oldString is absent', async () => {
    const db = createFakeDatabase(() => [versionRow()]);
    await expect(
      applyUpdate(db, { canvasId: 'canvas-1', newString: 'Canvas', oldString: 'missing' })
    ).resolves.toEqual({ error: 'no_match', ok: false });
    expect(db.calls).toHaveLength(1);
  });

  it('returns ambiguous_match without inserting when oldString occurs more than once, including overlaps', async () => {
    const db = createFakeDatabase(() => [versionRow({ html: '<p>aaa</p>' })]);
    await expect(
      applyUpdate(db, { canvasId: 'canvas-1', newString: 'new', oldString: 'aa' })
    ).resolves.toEqual({ error: 'ambiguous_match', ok: false });
    expect(db.calls).toHaveLength(1);
  });

  it('rewrites the latest canvas into a new version and preserves its identity metadata', async () => {
    const db = createFakeDatabase(({ params }, index) =>
      index === 0
        ? [versionRow({ createdBy: 'user', version: 5 })]
        : [{ canvasId: params?.[1], version: 6 }]
    );

    await expect(
      rewriteCanvas(db, { canvasId: 'canvas-1', html: '<p>Rewritten</p>' })
    ).resolves.toEqual({ canvasId: 'canvas-1', version: 6 });
    expect(db.calls[1]?.params?.slice(1)).toEqual([
      'canvas-1',
      'thread-1',
      'resource-1',
      'Draft',
      '<p>Rewritten</p>',
      6,
      'assistant',
    ]);
  });

  it('lists the latest version of each canvas for one thread', async () => {
    const latestA = versionRow({ canvasId: 'canvas-a', version: 2 });
    const latestB = versionRow({ canvasId: 'canvas-b', title: 'Second' });
    const db = createFakeDatabase(({ sql, params }) => {
      expect(sql).toMatch(/DISTINCT ON \(canvas_id\)/i);
      expect(sql).toMatch(/WHERE thread_id = \$1/i);
      expect(sql).toMatch(/ORDER BY canvas_id, version DESC/i);
      expect(params).toEqual(['thread-1']);
      return [latestA, latestB];
    });

    await expect(listCanvasesForThread(db, 'thread-1')).resolves.toEqual([latestA, latestB]);
  });
});
