/**
 * Multi-root assistant tools — REAL end-to-end integration.
 *
 * Unlike the per-tool unit specs (which mock the DB query layer), this harness
 * drives the actual tool execute() functions against a REAL PGlite database and
 * REAL on-disk workspace roots, simulating the assistant calling its tools in a
 * two-root workspace where both roots share a relative path (README.md). It is
 * the "put the tools through their paces" pass for the multi-root work.
 */

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { FileChunkRepository, migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { dbHolder } = vi.hoisted(() => ({ dbHolder: { db: null as unknown } }));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => dbHolder.db),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

const ROOT_A = { rootId: 'root-a', displayName: 'ProjectA' };
const ROOT_B = { rootId: 'root-b', displayName: 'ProjectB' };
const EMBED_DIM = 768;

function makeVector(entries: [number, number][]): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  for (const [idx, val] of entries) {
    v[idx] = val;
  }
  return v;
}
const QUERY_VECTOR = makeVector([[0, 1]]);

let db: PGlite;
let rootAPath: string;
let rootBPath: string;

function twoRootRuntime(): RuntimeData {
  return {
    workspaceRoots: [
      { rootId: ROOT_A.rootId, displayName: ROOT_A.displayName, path: rootAPath },
      { rootId: ROOT_B.rootId, displayName: ROOT_B.displayName, path: rootBPath },
    ],
    workspaceIndexEmbeddingSetId: 'set-1',
    workspaceIndexingEnabled: true,
    workspaceIndexStatusState: 'idle',
  } as unknown as RuntimeData;
}

describe('multi-root assistant tools (real PGlite + real roots)', () => {
  beforeAll(async () => {
    // 1. Real on-disk roots that share a relative path with distinct content.
    rootAPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-mr-a-'));
    rootBPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-mr-b-'));
    await fsPromises.writeFile(
      path.join(rootAPath, 'README.md'),
      '# Project A\nexport function fromA() { return 1; }\nconst sharedMarker = "alpha";\n',
      'utf8'
    );
    await fsPromises.writeFile(
      path.join(rootBPath, 'README.md'),
      '# Project B\nexport function fromB() { return 2; }\nconst sharedMarker = "beta";\n',
      'utf8'
    );

    // 2. Real PGlite with the full extension set + migrations.
    db = await wasmLoader.createPGlite('memory://multiroot-tools-integration');
    await migrate(db);
    dbHolder.db = db;

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path, status, created_at)
       VALUES ($1, 'path', $2, $3, 'live', $4), ($5, 'path', $6, $7, 'live', $8)`,
      [
        ROOT_A.rootId,
        ROOT_A.displayName,
        rootAPath,
        now,
        ROOT_B.rootId,
        ROOT_B.displayName,
        rootBPath,
        now,
      ]
    );
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      ['set-1', 'local::test-embed', 'test-embed', 768, 'cosine']
    );
    // Same relative path 'README.md' in BOTH roots (the disambiguation case),
    // plus a root-unique file in each.
    await db.query(
      `INSERT INTO file_records (id, name, path, root_id, embedding_set_id, size, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8), ($9,$10,$11,$12,$13,$14,$15,$16),
              ($17,$18,$19,$20,$21,$22,$23,$24), ($25,$26,$27,$28,$29,$30,$31,$32)`,
      [
        'fr-a-readme',
        'README.md',
        'README.md',
        ROOT_A.rootId,
        'set-1',
        100,
        now,
        now,
        'fr-b-readme',
        'README.md',
        'README.md',
        ROOT_B.rootId,
        'set-1',
        100,
        now,
        now,
        'fr-a-only',
        'only-a.ts',
        'src/only-a.ts',
        ROOT_A.rootId,
        'set-1',
        50,
        now,
        now,
        'fr-b-only',
        'only-b.ts',
        'src/only-b.ts',
        ROOT_B.rootId,
        'set-1',
        50,
        now,
        now,
      ]
    );

    const repo = new FileChunkRepository(db);
    const baseChunk = {
      tokenCount: 10,
      chunkType: 'code' as const,
      chunkSize: 50,
      embeddingSetId: 'set-1',
      createdAt: now,
      updatedAt: now,
    };
    // Embeddings + full source ranges so the SAME chunks serve both grep
    // (content) and queryEmbeddingSpace (vector + line/offset ranges; the
    // retrieval path skips chunks missing startOffset/endOffset).
    await repo.insertMany([
      {
        ...baseChunk,
        id: 'c-a-readme',
        contentHash: 'h1',
        fileRecordId: 'fr-a-readme',
        chunkIndex: 0,
        content: 'const sharedMarker = "alpha";',
        startLine: 3,
        endLine: 3,
        startOffset: 60,
        endOffset: 89,
        embedding: QUERY_VECTOR,
      },
      {
        ...baseChunk,
        id: 'c-b-readme',
        contentHash: 'h2',
        fileRecordId: 'fr-b-readme',
        chunkIndex: 0,
        content: 'const sharedMarker = "beta";',
        startLine: 3,
        endLine: 3,
        startOffset: 60,
        endOffset: 88,
        embedding: QUERY_VECTOR,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await db.close();
    await fsPromises.rm(rootAPath, { recursive: true, force: true });
    await fsPromises.rm(rootBPath, { recursive: true, force: true });
  });

  it('Task: "what folders are open?" — listWorkspaceContext lists both roots', async () => {
    const result = await buildDesktopAssistantTools(twoRootRuntime())[
      'brainstrike.listWorkspaceContext'
    ].execute({ context: {} });
    expect(result.workspaceRoots).toEqual([
      { rootId: ROOT_A.rootId, displayName: ROOT_A.displayName, path: rootAPath },
      { rootId: ROOT_B.rootId, displayName: ROOT_B.displayName, path: rootBPath },
    ]);
  });

  it('Task: grep a shared term — content matches are labelled and same-path roots stay distinct', async () => {
    const result = await buildDesktopAssistantTools(twoRootRuntime())[
      'brainstrike.grepSearch'
    ].execute({ context: { pattern: 'sharedMarker', outputMode: 'content' } });
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode');
    }
    expect(result.matches).toHaveLength(2);
    const labelled = result.matches.map((m) => `${m.rootName}/${m.path}:${m.line}`).sort();
    expect(labelled).toEqual(['ProjectA/README.md:3', 'ProjectB/README.md:3']);
  });

  it('Task: grep scoped to one folder via `root` — only that root matches', async () => {
    const result = await buildDesktopAssistantTools(twoRootRuntime())[
      'brainstrike.grepSearch'
    ].execute({ context: { pattern: 'sharedMarker', outputMode: 'content', root: 'ProjectB' } });
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode');
    }
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.rootName).toBe('ProjectB');
    expect(result.matches[0]?.lineText).toContain('beta');
  });

  it('Task: read README.md with no root (ambiguous) — errors and lists the open folders', async () => {
    await expect(
      buildDesktopAssistantTools(twoRootRuntime())['brainstrike.readWorkspaceFile'].execute({
        context: { path: '/README.md' },
      })
    ).rejects.toThrow(/multiple folders.*ProjectA.*ProjectB/is);
  });

  it("Task: read README.md qualified by root — returns the correct root's file", async () => {
    const tools = buildDesktopAssistantTools(twoRootRuntime());
    const a = await tools['brainstrike.readWorkspaceFile'].execute({
      context: { path: '/README.md', root: 'ProjectA' },
    });
    expect(a.rootName).toBe('ProjectA');
    expect(a.content).toContain('Project A');
    expect(a.content).not.toContain('Project B');

    const b = await tools['brainstrike.readWorkspaceFile'].execute({
      context: { path: '/README.md', root: ROOT_B.rootId },
    });
    expect(b.rootName).toBe('ProjectB');
    expect(b.content).toContain('Project B');
  });

  it('Task: list a directory in a chosen root — labelled and root-scoped', async () => {
    const result = await buildDesktopAssistantTools(twoRootRuntime())[
      'brainstrike.readWorkspaceDirectory'
    ].execute({ context: { path: '/', root: 'ProjectA' } });
    expect(result.rootName).toBe('ProjectA');
    expect(result.entries.some((e: { path: string }) => e.path === '/README.md')).toBe(true);
  });

  it('Task: find a symbol in a chosen root — labelled', async () => {
    const result = await buildDesktopAssistantTools(twoRootRuntime())[
      'brainstrike.findWorkspaceSymbol'
    ].execute({ context: { path: '/README.md', query: 'fromB', root: 'ProjectB' } });
    expect(result.rootName).toBe('ProjectB');
    expect(result.totalMatches).toBeGreaterThan(0);
  });

  it('Task: semantic search — retrieved chunks are labelled by root and the context is root-prefixed', async () => {
    const tools = buildDesktopAssistantTools(twoRootRuntime(), {
      embeddingHostManager: { queryEmbedding: vi.fn(async () => QUERY_VECTOR) },
    });
    const result = await tools['brainstrike.queryEmbeddingSpace'].execute({
      context: { query: 'shared marker', embeddingSetId: 'set-1', threshold: 0 },
    });
    if ('status' in result) {
      throw new Error('expected a retrieval result');
    }
    // Both roots' README chunks come back, each carrying its owning root.
    const rootNames = result.chunks
      .map((c: { metadata?: Record<string, unknown> }) => c.metadata?.['rootName'])
      .sort();
    expect(rootNames).toEqual(['ProjectA', 'ProjectB']);
    // The model-visible context string disambiguates the same relative path.
    expect(result.context).toContain('[ProjectA]');
    expect(result.context).toContain('[ProjectB]');
  });

  it('Task: semantic search scoped by root — only the chosen root is retrieved', async () => {
    const tools = buildDesktopAssistantTools(twoRootRuntime(), {
      embeddingHostManager: { queryEmbedding: vi.fn(async () => QUERY_VECTOR) },
    });
    const result = await tools['brainstrike.queryEmbeddingSpace'].execute({
      context: { query: 'shared marker', embeddingSetId: 'set-1', threshold: 0, root: 'ProjectA' },
    });
    if ('status' in result) {
      throw new Error('expected a retrieval result');
    }
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(
      result.chunks.every(
        (c: { metadata?: Record<string, unknown> }) => c.metadata?.['rootName'] === 'ProjectA'
      )
    ).toBe(true);
  });
});
