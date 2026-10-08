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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbHolder } = vi.hoisted(() => ({ dbHolder: { db: null as unknown } }));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => dbHolder.db),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { resetToolCallLoopGuards } from '@brainstrike/host-capabilities/native-tools';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { requireToolExecute } from './_tool-test-helpers';

const ROOT_A = { displayName: 'ProjectA', rootId: 'root-a' };
const ROOT_B = { displayName: 'ProjectB', rootId: 'root-b' };
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
    workspaceIndexEmbeddingSetId: 'set-1',
    workspaceIndexingEnabled: true,
    workspaceIndexStatusState: 'idle',
    workspaceRoots: [
      { displayName: ROOT_A.displayName, path: rootAPath, rootId: ROOT_A.rootId },
      { displayName: ROOT_B.displayName, path: rootBPath, rootId: ROOT_B.rootId },
    ],
  } as unknown as RuntimeData;
}

describe('multi-root assistant tools (real PGlite + real roots)', () => {
  beforeEach(() => {
    resetToolCallLoopGuards();
  });

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
      chunkSize: 50,
      chunkType: 'code' as const,
      createdAt: now,
      embeddingSetId: 'set-1',
      tokenCount: 10,
      updatedAt: now,
    };
    // Embeddings + full source ranges so the SAME chunks serve both grep
    // (content) and queryEmbeddingSpace (vector + line/offset ranges; the
    // retrieval path skips chunks missing startOffset/endOffset).
    await repo.insertMany([
      {
        ...baseChunk,
        chunkIndex: 0,
        content: 'const sharedMarker = "alpha";',
        contentHash: 'h1',
        embedding: QUERY_VECTOR,
        endLine: 3,
        endOffset: 89,
        fileRecordId: 'fr-a-readme',
        id: 'c-a-readme',
        startLine: 3,
        startOffset: 60,
      },
      {
        ...baseChunk,
        chunkIndex: 0,
        content: 'const sharedMarker = "beta";',
        contentHash: 'h2',
        embedding: QUERY_VECTOR,
        endLine: 3,
        endOffset: 88,
        fileRecordId: 'fr-b-readme',
        id: 'c-b-readme',
        startLine: 3,
        startOffset: 60,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await db.close();
    await fsPromises.rm(rootAPath, { force: true, recursive: true });
    await fsPromises.rm(rootBPath, { force: true, recursive: true });
  });

  it('Task: "what folders are open?" — listWorkspaceContext lists both roots', async () => {
    const executeTool = requireToolExecute(
      buildDesktopAssistantTools(twoRootRuntime()),
      'brainstrike.listWorkspaceContext'
    );
    const result = await executeTool({ context: {} });
    expect(result.workspaceRoots).toEqual([
      { displayName: ROOT_A.displayName, path: rootAPath, rootId: ROOT_A.rootId },
      { displayName: ROOT_B.displayName, path: rootBPath, rootId: ROOT_B.rootId },
    ]);
  });

  it('Task: grep a shared term — content matches are labelled and same-path roots stay distinct', async () => {
    const executeTool = requireToolExecute(
      buildDesktopAssistantTools(twoRootRuntime()),
      'brainstrike.grepSearch'
    );
    const result = await executeTool({
      context: { outputMode: 'content', pattern: 'sharedMarker' },
    });
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode');
    }
    expect(result.matches).toHaveLength(2);
    const labelled = result.matches
      .map(
        (match: { line: number; path: string; rootName: string }) =>
          `${match.rootName}/${match.path}:${match.line}`
      )
      .sort();
    expect(labelled).toEqual(['ProjectA/README.md:3', 'ProjectB/README.md:3']);
  });

  it('Task: grep scoped to one folder via `root` — only that root matches', async () => {
    const executeTool = requireToolExecute(
      buildDesktopAssistantTools(twoRootRuntime()),
      'brainstrike.grepSearch'
    );
    const result = await executeTool({
      context: { outputMode: 'content', pattern: 'sharedMarker', root: 'ProjectB' },
    });
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode');
    }
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.rootName).toBe('ProjectB');
    expect(result.matches[0]?.lineText).toContain('beta');
  });

  it('Task: read README.md with no root (ambiguous) — errors and lists the open folders', async () => {
    const executeTool = requireToolExecute(
      buildDesktopAssistantTools(twoRootRuntime()),
      'brainstrike.readWorkspaceFile'
    );
    await expect(executeTool({ context: { path: '/README.md' } })).rejects.toThrow(
      /multiple folders.*ProjectA.*ProjectB/is
    );
  });

  it("Task: read README.md qualified by root — returns the correct root's file", async () => {
    const tools = buildDesktopAssistantTools(twoRootRuntime());
    const executeTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
    const a = await executeTool({
      context: { path: '/README.md', root: 'ProjectA' },
    });
    expect(a.rootName).toBe('ProjectA');
    expect(a.content).toContain('Project A');
    expect(a.content).not.toContain('Project B');

    const b = await executeTool({
      context: { path: '/README.md', root: ROOT_B.rootId },
    });
    expect(b.rootName).toBe('ProjectB');
    expect(b.content).toContain('Project B');
  });

  it('Task: list a directory in a chosen root — labelled and root-scoped', async () => {
    const executeTool = requireToolExecute(
      buildDesktopAssistantTools(twoRootRuntime()),
      'brainstrike.readWorkspaceDirectory'
    );
    const result = await executeTool({ context: { path: '/', root: 'ProjectA' } });
    expect(result.rootName).toBe('ProjectA');
    expect(result.entries.some((e: { path: string }) => e.path === '/README.md')).toBe(true);
  });

  it('Task: find a symbol in a chosen root — labelled', async () => {
    const executeTool = requireToolExecute(
      buildDesktopAssistantTools(twoRootRuntime()),
      'brainstrike.findWorkspaceSymbol'
    );
    const result = await executeTool({
      context: { path: '/README.md', query: 'fromB', root: 'ProjectB' },
    });
    expect(result.rootName).toBe('ProjectB');
    expect(result.totalMatches).toBeGreaterThan(0);
  });

  it('Task: read curated context in a chosen root (explicit filePaths) — labelled by root', async () => {
    const executeTool = requireToolExecute(
      buildDesktopAssistantTools(twoRootRuntime()),
      'brainstrike.readWorkspaceContext'
    );
    const result = await executeTool({
      context: { filePaths: ['/README.md'], root: 'ProjectB' },
    });
    expect(result.rootName).toBe('ProjectB');
    expect(result.files[0]?.content).toContain('Project B');
  });

  it('Task: read curated context without root (ambiguous) — errors and lists the open folders', async () => {
    const executeTool = requireToolExecute(
      buildDesktopAssistantTools(twoRootRuntime()),
      'brainstrike.readWorkspaceContext'
    );
    await expect(executeTool({ context: { filePaths: ['/README.md'] } })).rejects.toThrow(
      /multiple folders.*ProjectA.*ProjectB/is
    );
  });

  it('Task: selection write-back routes to a non-focused root (validated against that root)', async () => {
    // ProjectA is focused; the model curates ProjectB. The server validates the
    // file against ProjectB's real path and broadcasts its rootPath (the renderer
    // maps that to the matching client folder — verified live on desktop).
    const focusedRuntime = {
      ...twoRootRuntime(),
      selectionFolderId: 'client-folder-uuid',
      workspaceRootPath: rootAPath,
    } as unknown as RuntimeData;
    const executeTool = requireToolExecute(
      buildDesktopAssistantTools(focusedRuntime),
      'brainstrike.updateWorkspaceContextSelection'
    );
    const result = await executeTool({
      context: { filePaths: ['/README.md'], root: 'ProjectB' },
    });
    expect(result.appliedCount).toBe(1);
  });

  it('Task: semantic search — retrieved chunks are labelled by root and the context is root-prefixed', async () => {
    const tools = buildDesktopAssistantTools(twoRootRuntime(), {
      embeddingHostManager: { queryEmbedding: vi.fn(async () => QUERY_VECTOR) },
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.queryEmbeddingSpace');
    const result = await executeTool({
      context: { embeddingSetId: 'set-1', query: 'shared marker', threshold: 0 },
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

  it('passes the native tool abort signal to local query embedding', async () => {
    const queryEmbedding = vi.fn(async () => QUERY_VECTOR);
    const tools = buildDesktopAssistantTools(twoRootRuntime(), {
      embeddingHostManager: { queryEmbedding },
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.queryEmbeddingSpace');
    const signal = new AbortController().signal;

    await executeTool(
      { context: { embeddingSetId: 'set-1', query: 'shared marker', threshold: 0 } },
      { abortSignal: signal }
    );
    expect(queryEmbedding).toHaveBeenCalledWith(expect.any(Object), { signal });
  });

  it('Task: semantic search scoped by root — only the chosen root is retrieved', async () => {
    const tools = buildDesktopAssistantTools(twoRootRuntime(), {
      embeddingHostManager: { queryEmbedding: vi.fn(async () => QUERY_VECTOR) },
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.queryEmbeddingSpace');
    const result = await executeTool({
      context: { embeddingSetId: 'set-1', query: 'shared marker', root: 'ProjectA', threshold: 0 },
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
