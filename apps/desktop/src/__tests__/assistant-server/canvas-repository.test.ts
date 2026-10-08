import { CANVAS_HTML_MAX_BYTES } from '@brainstrike/assistant-contract';
import { CANVAS_LIST_LIMIT, type CanvasSummary } from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it } from 'vitest';
import {
  applyUpdate,
  type CanvasDatabase,
  type CanvasVersion,
  createCanvas,
  getLatestVersionForThread,
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

const slotMarker = '<!--slot-->';

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
    if (!('canvasId' in result)) {
      throw new Error('expected create success');
    }
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

  it('reads the latest version thread-scoped, with a text-cast timestamp and validated created_by', async () => {
    const db = createFakeDatabase(({ sql, params }) => {
      expect(sql).toContain('created_at::text AS "createdAt"');
      expect(sql).toMatch(/WHERE canvas_id = \$1 AND thread_id = \$2/i);
      expect(sql).toMatch(/ORDER BY version DESC/i);
      expect(params).toEqual(['canvas-1', 'thread-1']);
      return [versionRow()];
    });

    await expect(getLatestVersionForThread(db, 'canvas-1', 'thread-1')).resolves.toEqual(
      versionRow()
    );

    const corrupt = createFakeDatabase(() => [versionRow({ createdBy: 'system' as 'assistant' })]);
    await expect(getLatestVersionForThread(corrupt, 'canvas-1', 'thread-1')).rejects.toThrow(
      /created_by|creator/i
    );
  });

  it('returns the same uniform not_found for missing AND cross-thread canvases (no existence oracle)', async () => {
    const db = createFakeDatabase(() => []);
    await expect(getLatestVersionForThread(db, 'missing', 'thread-1')).resolves.toEqual({
      error: 'not_found',
      ok: false,
    });
    // A cross-thread id produces zero rows through the same thread-scoped
    // query, hence a byte-identical result to a nonexistent id.
    await expect(
      applyUpdate(db, {
        canvasId: 'other-threads-canvas',
        newString: 'x',
        oldString: 'y',
        threadId: 'thread-1',
      })
    ).resolves.toEqual({ error: 'not_found', ok: false });
  });

  // The schema bounds each FIELD; only applyUpdate COMPOSES one. A near-limit
  // document plus an individually valid replacement lands above the ceiling,
  // and repeated updates would keep growing it — so the composed result is
  // checked before insertion. Both strings here pass the schema on their own.
  // The choke point covers CREATE too, not just the composing path. Before the
  // check moved into insertVersion, create and rewrite were bounded by the input
  // schema alone — so any caller reaching the repository without parsing first
  // was unbounded.
  it('refuses a create whose html exceeds the byte ceiling', async () => {
    let inserted = false;
    const db = createFakeDatabase(() => {
      inserted = true;
      return [{ canvasId: 'canvas-1', version: 1 }];
    });

    const result = await createCanvas(db, {
      createdBy: 'assistant',
      // Under .max() as a code-point count, over it as bytes.
      html: '\u{1F600}'.repeat(3_000_000),
      resourceId: 'resource-1',
      threadId: 'thread-1',
      title: 'Too big',
    });

    expect(result).toEqual({ error: 'too_large', ok: false });
    expect(inserted).toBe(false);
  });

  it('refuses an update whose COMPOSED html exceeds the byte ceiling', async () => {
    // The BASE has to be under the ceiling, or this proves nothing about
    // composition — an already-oversized document would be refused whatever the
    // replacement was. Asserted rather than assumed, because getting this wrong
    // is invisible: the test still passes.
    const base = `${'a'.repeat(CANVAS_HTML_MAX_BYTES - 4_000_000)}${slotMarker}`;
    expect(new TextEncoder().encode(base).length).toBeLessThan(CANVAS_HTML_MAX_BYTES);
    let inserted = false;
    const db = createFakeDatabase((_call, index) => {
      if (index === 0) {
        return [versionRow({ html: base, version: 3 })];
      }
      inserted = true;
      return [{ canvasId: 'canvas-1', version: 4 }];
    });

    const result = await applyUpdate(db, {
      canvasId: 'canvas-1',
      // Individually fine — 1.5M code points, well under .max() — but 6 MB of
      // UTF-8 replacing 11 bytes, which carries an in-bounds document over.
      newString: '\u{1F600}'.repeat(1_500_000),
      oldString: slotMarker,
      threadId: 'thread-1',
    });

    expect(result).toEqual({ error: 'too_large', ok: false });
    expect(inserted).toBe(false);
  });

  // Reaches the PRE-CHECK, which the case above does not: 5,000,011 - 11 +
  // 4,000,000 UTF-16 units is 9,000,000, over the ceiling before any encoding.
  // The case above lands at 7,000,000 units and is caught by insertVersion.
  //
  // Stated plainly: no assertion can DISTINGUISH the two paths, because the
  // pre-check is an allocation guard, not a correctness one — deleting it leaves
  // insertVersion to reject the same input with the same result, and only the
  // transient ~18 MB composition differs. So this covers the branch and pins the
  // behaviour; it cannot be mutated red on its own, and pretending otherwise
  // would be the kind of decorative guard this repo refuses elsewhere.
  it('refuses an oversized composition before materialising it', async () => {
    let inserted = false;
    const db = createFakeDatabase((_call, index) => {
      if (index === 0) {
        return [versionRow({ html: `${'a'.repeat(5_000_000)}${slotMarker}`, version: 3 })];
      }
      inserted = true;
      return [{ canvasId: 'canvas-1', version: 4 }];
    });

    const result = await applyUpdate(db, {
      canvasId: 'canvas-1',
      newString: '\u{1F600}'.repeat(2_000_000),
      oldString: slotMarker,
      threadId: 'thread-1',
    });

    expect(result).toEqual({ error: 'too_large', ok: false });
    expect(inserted).toBe(false);
  });

  it('still allows an update that stays within the ceiling', async () => {
    const db = createFakeDatabase((_call, index) =>
      index === 0
        ? [versionRow({ html: '<p><!--slot--></p>', version: 3 })]
        : [{ canvasId: 'canvas-1', version: 4 }]
    );

    await expect(
      applyUpdate(db, {
        canvasId: 'canvas-1',
        newString: '\u{1F600}'.repeat(1000),
        oldString: '<!--slot-->',
        threadId: 'thread-1',
      })
    ).resolves.toEqual({ canvasId: 'canvas-1', version: 4 });
  });

  it('maps a unique-constraint race to a structured retryable version_conflict', async () => {
    const db = createFakeDatabase((_call, index) => {
      if (index === 0) {
        return [versionRow({ version: 3 })];
      }
      throw Object.assign(
        new Error(
          'duplicate key value violates unique constraint "brainstrike_canvas_versions_canvas_id_version_key"'
        ),
        { code: '23505' }
      );
    });
    await expect(
      applyUpdate(db, {
        canvasId: 'canvas-1',
        newString: 'Canvas',
        oldString: 'world',
        threadId: 'thread-1',
      })
    ).resolves.toEqual({ error: 'version_conflict', ok: false });
  });

  it('applies an exact single replacement into a new assistant-authored version', async () => {
    const db = createFakeDatabase(({ params }, index) => {
      if (index === 0) {
        return [versionRow({ version: 3 })];
      }
      return [{ canvasId: params?.[1], version: params?.[6] }];
    });

    await expect(
      applyUpdate(db, {
        canvasId: 'canvas-1',
        newString: 'Canvas',
        oldString: 'world',
        threadId: 'thread-1',
      })
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
      applyUpdate(db, {
        canvasId: 'canvas-1',
        newString: 'Canvas',
        oldString: 'missing',
        threadId: 'thread-1',
      })
    ).resolves.toEqual({ error: 'no_match', ok: false });
    expect(db.calls).toHaveLength(1);
  });

  it('returns ambiguous_match without inserting when oldString occurs more than once, including overlaps', async () => {
    const db = createFakeDatabase(() => [versionRow({ html: '<p>aaa</p>' })]);
    await expect(
      applyUpdate(db, {
        canvasId: 'canvas-1',
        newString: 'new',
        oldString: 'aa',
        threadId: 'thread-1',
      })
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
      rewriteCanvas(db, { canvasId: 'canvas-1', html: '<p>Rewritten</p>', threadId: 'thread-1' })
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

  it('lists thread canvases as summaries only — never html — with an explicit truncation flag', async () => {
    const summary = (index: number): CanvasSummary => ({
      canvasId: `canvas-${index}`,
      createdAt: '2026-08-06 12:34:56.123456+00',
      title: `Canvas ${index}`,
      version: 1,
    });
    const db = createFakeDatabase(({ sql, params }) => {
      expect(sql).toMatch(/DISTINCT ON \(canvas_id\)/i);
      expect(sql).toMatch(/WHERE thread_id = \$1/i);
      expect(sql).not.toMatch(/html/i);
      expect(sql).toContain(`LIMIT ${CANVAS_LIST_LIMIT + 1}`);
      expect(params).toEqual(['thread-1']);
      return [summary(1), summary(2)];
    });

    await expect(listCanvasesForThread(db, 'thread-1')).resolves.toEqual({
      canvases: [summary(1), summary(2)],
      truncated: false,
    });

    const overflowing = createFakeDatabase(() =>
      Array.from({ length: CANVAS_LIST_LIMIT + 1 }, (_value, index) => summary(index))
    );
    const overflowResult = await listCanvasesForThread(overflowing, 'thread-1');
    expect(overflowResult.truncated).toBe(true);
    expect(overflowResult.canvases).toHaveLength(CANVAS_LIST_LIMIT);
  });
});
