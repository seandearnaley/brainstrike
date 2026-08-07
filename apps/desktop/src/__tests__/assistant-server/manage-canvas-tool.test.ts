import type { ManageCanvasInput, RuntimeData } from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import type { CanvasDatabase } from '../../assistant-server/canvas-repository';
import { runManageCanvas } from '../../assistant-server/manage-canvas-tool';

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
        return { rows: [...latest.values()] as T[] };
      }
      if (/FROM brainstrike_canvas_versions/i.test(sql)) {
        const canvasId = String(params?.[0]);
        const latest = versions
          .filter((candidate) => candidate.canvasId === canvasId)
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
  return await runManageCanvas(input, runtimeData, { database: db });
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
    expect(listed).toMatchObject({
      canvases: [
        {
          canvasId: created.canvasId,
          createdBy: 'assistant',
          html: '<p>Final</p>',
          resourceId: 'resource-1',
          threadId: 'thread-1',
          title: 'Draft',
          version: 3,
        },
      ],
    });
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

  it('returns a structured error when there is no active thread or resource', async () => {
    const db = createFakeDb();
    await expect(run(db, { action: 'list' }, {} as RuntimeData)).resolves.toEqual({
      error: expect.stringContaining('thread'),
      ok: false,
    });
    expect(db.versions).toEqual([]);
  });
});
