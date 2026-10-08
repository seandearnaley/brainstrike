import type { ManageCanvasInput, RuntimeData } from '@brainstrike/agent';
import { runManageCanvas } from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import {
  type CanvasDatabase,
  createDesktopCanvasStore,
} from '../../assistant-server/canvas-repository';

interface StoredVersion {
  readonly canvasId: string;
  readonly createdAt: string;
  readonly createdBy: 'assistant' | 'user';
  readonly html: string;
  readonly id: string;
  readonly resourceId: string;
  readonly threadId: string;
  readonly title: string;
  readonly version: number;
}

function createFakeDb(): CanvasDatabase & { readonly versions: StoredVersion[] } {
  const versions: StoredVersion[] = [];
  return {
    query: async <T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> => {
      if (/INSERT INTO brainstrike_canvas_versions/i.test(sql)) {
        const row: StoredVersion = {
          canvasId: String(params?.[1]),
          createdAt: '2026-08-06 12:00:00+00',
          createdBy: String(params?.[7]) as StoredVersion['createdBy'],
          html: String(params?.[5]),
          id: String(params?.[0]),
          resourceId: String(params?.[3]),
          threadId: String(params?.[2]),
          title: String(params?.[4]),
          version: Number(params?.[6]),
        };
        versions.push(row);
        return { rows: [{ canvasId: row.canvasId, version: row.version }] as T[] };
      }
      if (/DISTINCT ON \(canvas_id\)/i.test(sql)) {
        const threadId = String(params?.[0]);
        const latest = new Map<string, StoredVersion>();
        for (const row of versions.filter((candidate) => candidate.threadId === threadId)) {
          const previous = latest.get(row.canvasId);
          if (!previous || row.version > previous.version) {
            latest.set(row.canvasId, row);
          }
        }
        // Summary shape mirrors the real list SQL: no html, no ids beyond canvasId.
        return {
          rows: [...latest.values()].map((row) => ({
            canvasId: row.canvasId,
            createdAt: row.createdAt,
            title: row.title,
            version: row.version,
          })) as T[],
        };
      }
      if (/FROM brainstrike_canvas_versions/i.test(sql)) {
        const canvasId = String(params?.[0]);
        const threadId = String(params?.[1]);
        const latest = versions
          .filter((candidate) => candidate.canvasId === canvasId && candidate.threadId === threadId)
          .sort((left, right) => right.version - left.version)[0];
        return { rows: (latest ? [latest] : []) as T[] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    versions,
  };
}

function runtimeWithThread(threadId = 'thread-1', resourceId = 'resource-1'): RuntimeData {
  return { memory: { resourceId, threadId } } as RuntimeData;
}

async function run(
  db: CanvasDatabase,
  input: ManageCanvasInput,
  runtimeData: RuntimeData | undefined = runtimeWithThread()
) {
  const memory = runtimeData?.memory;
  const store =
    memory?.threadId && memory.resourceId
      ? createDesktopCanvasStore({ resourceId: memory.resourceId, threadId: memory.threadId }, db)
      : undefined;
  return await runManageCanvas(input, store);
}

describe('runManageCanvas', () => {
  it('is registered in the desktop assistant tool map with its canonical schema', () => {
    const tools = buildDesktopAssistantTools(runtimeWithThread());
    expect(tools['brainstrike.manageCanvas']).toMatchObject({
      description: expect.any(String),
      execute: expect.any(Function),
      id: 'brainstrike.manageCanvas',
      inputSchema: expect.any(Object),
    });
  });

  it('creates, updates, rewrites, and lists a versioned canvas for the active thread', async () => {
    const db = createFakeDb();
    const created = await run(db, {
      action: 'create',
      html: '<p>Hello world</p>',
      title: 'Draft',
    });
    expect(created).toEqual({ canvasId: expect.any(String), version: 1 });
    if (!('canvasId' in created)) {
      throw new Error('expected create result');
    }

    await expect(
      run(db, {
        action: 'update',
        canvasId: created.canvasId,
        newString: 'Canvas',
        oldString: 'world',
      })
    ).resolves.toEqual({ canvasId: created.canvasId, version: 2 });
    await expect(
      run(db, { action: 'rewrite', canvasId: created.canvasId, html: '<p>Final</p>' })
    ).resolves.toEqual({ canvasId: created.canvasId, version: 3 });

    const listed = await run(db, { action: 'list' });
    expect(listed).toEqual({
      canvases: [
        {
          canvasId: created.canvasId,
          createdAt: expect.any(String),
          title: 'Draft',
          version: 3,
        },
      ],
      truncated: false,
    });
    // Listings must never inline canvas html into model context.
    expect(JSON.stringify(listed)).not.toContain('<p>Final</p>');
  });

  it('scopes mutations to the calling thread: a foreign canvas id is uniformly not_found', async () => {
    const db = createFakeDb();
    const created = await run(db, { action: 'create', html: '<p>Mine</p>', title: 'Mine' });
    if (!('canvasId' in created)) {
      throw new Error('expected create result');
    }

    await expect(
      run(
        db,
        { action: 'rewrite', canvasId: created.canvasId, html: '<p>Stolen</p>' },
        runtimeWithThread('other-thread', 'other-resource')
      )
    ).resolves.toEqual({ error: 'not_found', ok: false });
    // The other thread's write never landed.
    expect(db.versions).toHaveLength(1);
    expect(db.versions[0]?.html).toBe('<p>Mine</p>');
  });

  it('propagates structured no-match and ambiguous-match results', async () => {
    const db = createFakeDb();
    const created = await run(db, { action: 'create', html: 'same same', title: 'Draft' });
    if (!('canvasId' in created)) {
      throw new Error('expected create result');
    }

    await expect(
      run(db, {
        action: 'update',
        canvasId: created.canvasId,
        newString: 'new',
        oldString: 'missing',
      })
    ).resolves.toEqual({ error: 'no_match', ok: false });
    await expect(
      run(db, {
        action: 'update',
        canvasId: created.canvasId,
        newString: 'new',
        oldString: 'same',
      })
    ).resolves.toEqual({ error: 'ambiguous_match', ok: false });
  });

  it('refuses an empty create with a hint to create when the content is ready, and writes nothing', async () => {
    const db = createFakeDb();
    // The verifier run 6/7 shape: a titled shell created "to receive the report".
    const refused = await run(db, {
      action: 'create',
      html: '<html><head><title>Report</title></head><body></body></html>',
      title: 'Findings report',
    });
    expect(refused).toEqual({
      error: 'empty_document',
      hint: expect.stringContaining('content is ready'),
      ok: false,
    });
    // Mutation: checking AFTER the insert (or not at all) leaves a version row.
    expect(db.versions).toEqual([]);
  });

  it('leaves update and rewrite unchanged: an empty replacement and an empty rewrite still version', async () => {
    const db = createFakeDb();
    const created = await run(db, { action: 'create', html: '<p>draft</p>', title: 'Draft' });
    if (!('canvasId' in created)) {
      throw new Error('expected create result');
    }
    // update's empty newString is the documented "delete the match" — a CREATE
    // rule must not leak into it.
    await expect(
      run(db, { action: 'update', canvasId: created.canvasId, newString: '', oldString: 'draft' })
    ).resolves.toEqual({ canvasId: created.canvasId, version: 2 });
    // rewrite to an empty document is a deliberate act on a document the user
    // already has, and stays reversible through the version stepper.
    await expect(
      run(db, { action: 'rewrite', canvasId: created.canvasId, html: '<p></p>' })
    ).resolves.toEqual({ canvasId: created.canvasId, version: 3 });
  });

  it('returns a structured error when there is no active thread or resource', async () => {
    const db = createFakeDb();
    await expect(run(db, { action: 'list' }, {} as RuntimeData)).resolves.toEqual({
      error: 'no_active_thread',
      hint: expect.stringContaining('thread'),
      ok: false,
    });
    expect(db.versions).toEqual([]);
  });
});
