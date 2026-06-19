/**
 * RAG coherence after edits (PR-2.3) — REAL end-to-end integration.
 *
 * Drives the ACTUAL desktop `writeWorkspaceFile` / `stringReplaceWorkspaceFile`
 * tool `execute()` (from `buildDesktopAssistantTools`) against a REAL PGlite
 * database and a REAL on-disk workspace root, proving that a successful edit to
 * an INDEXED file re-indexes it through the SAME entry point the background
 * indexer uses (`applyManagedCacheBatch` replace): stale chunks are deleted,
 * in-flight `embed_chunk` jobs are canceled, and the file_records row is marked
 * un-chunked (`chunks_processed_at = NULL`) so the renderer re-chunks + re-embeds
 * on its next pass. Also proves the no-op path (path not indexed → no row, no
 * error) and that a re-index FAILURE never undoes the already-written edit.
 *
 * Mirrors the harness in multiroot-tools.integration.test.ts.
 */

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbHolder } = vi.hoisted(() => ({ dbHolder: { db: null as unknown } }));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => dbHolder.db),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

const ROOT_ID = 'root-1';
const EMBEDDING_SET_ID = 'set-1';
const INDEXED_REL_PATH = 'src/indexed.ts';
const FILE_RECORD_ID = 'fr-indexed';
const CHUNK_ID = 'chunk-indexed-1';
const EMBED_JOB_ID = 'job-indexed-1';

let db: PGlite;
let rootPath: string;

function runtime(): RuntimeData {
  return {
    workspaceRoots: [{ rootId: ROOT_ID, displayName: 'Project', path: rootPath }],
    workspaceIndexEmbeddingSetId: EMBEDDING_SET_ID,
    workspaceIndexingEnabled: true,
  } as unknown as RuntimeData;
}

interface JobRow {
  chunk_id: string | null;
  state: string;
}

interface FileRecordRow {
  chunks_count: number | null;
  chunks_processed_at: string | null;
  content: string;
  content_hash: string;
}

async function readFileRecord(id: string): Promise<FileRecordRow | undefined> {
  const result = await db.query<FileRecordRow>(
    'SELECT content, content_hash, chunks_processed_at, chunks_count FROM file_records WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

async function seedIndexedFile(content: string): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO file_records
       (id, name, path, root_id, embedding_set_id, size, content, content_hash,
        token_count, chunks_count, chunks_processed_at, created_at, updated_at, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12)`,
    [
      FILE_RECORD_ID,
      'indexed.ts',
      INDEXED_REL_PATH,
      ROOT_ID,
      EMBEDDING_SET_ID,
      content.length,
      content,
      'stale-content-hash',
      Math.ceil(content.length / 4),
      1,
      now,
      now,
    ]
  );
  // A chunk + a queued embed job that the re-index must clear/cancel.
  await db.query(
    `INSERT INTO file_chunks
       (id, file_record_id, chunk_index, content, content_hash, token_count,
        chunk_type, chunk_size, embedding_set_id, created_at, updated_at)
     VALUES ($1,$2,0,$3,$4,4,'sentence',16,$5,$6,$6)`,
    [
      CHUNK_ID,
      FILE_RECORD_ID,
      'stale chunk',
      'stale-chunk-hash',
      EMBEDDING_SET_ID,
      new Date().toISOString(),
    ]
  );
  await db.query(
    `INSERT INTO job_queue
       (id, queue, job_type, payload, chunk_id, state, run_at, created_at, updated_at)
     VALUES ($1, 'embeddings', 'embed_chunk', $2::jsonb, $3, 'queued', $4, $4, $4)`,
    [EMBED_JOB_ID, JSON.stringify({ chunkId: CHUNK_ID }), CHUNK_ID, new Date().toISOString()]
  );
}

beforeEach(async () => {
  rootPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-reindex-'));
  db = await wasmLoader.createPGlite('memory://reindex-on-edit-integration');
  await migrate(db);
  dbHolder.db = db;
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO roots (id, kind, display_name, path, status, created_at)
     VALUES ($1, 'path', 'Project', $2, 'live', $3)`,
    [ROOT_ID, rootPath, now]
  );
  await db.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
    [EMBEDDING_SET_ID, 'local::test-embed', 'test-embed', 768, 'cosine']
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
  await fsPromises.rm(rootPath, { recursive: true, force: true });
});

describe('re-index on edit (writeWorkspaceFile)', () => {
  it('re-indexes an indexed file after a write: clears stale chunks, cancels jobs, marks un-chunked', async () => {
    await fsPromises
      .writeFile(path.join(rootPath, 'src', 'indexed.ts'), 'old', { encoding: 'utf8', flag: 'w' })
      .catch(async () => {
        await fsPromises.mkdir(path.join(rootPath, 'src'), { recursive: true });
        await fsPromises.writeFile(path.join(rootPath, 'src', 'indexed.ts'), 'old', 'utf8');
      });
    await seedIndexedFile('export const value = 1;\n');

    const tools = buildDesktopAssistantTools(runtime());
    const writeTool = tools['brainstrike.writeWorkspaceFile'];
    expect(writeTool).toBeDefined();

    const newContent = 'export const value = 999;\n// edited by agent\n';
    const result = (await writeTool?.execute?.({
      path: `/${INDEXED_REL_PATH}`,
      content: newContent,
    })) as { bytesWritten: number } | undefined;

    expect(result?.bytesWritten).toBe(Buffer.byteLength(newContent, 'utf8'));

    // file_records row was replaced: new content, fresh hash, marked un-chunked.
    const record = await readFileRecord(FILE_RECORD_ID);
    expect(record?.content).toBe(newContent);
    expect(record?.content_hash).not.toBe('stale-content-hash');
    expect(record?.chunks_processed_at).toBeNull();
    expect(record?.chunks_count).toBe(0);

    // Stale chunk deleted.
    const chunks = await db.query('SELECT id FROM file_chunks WHERE file_record_id = $1', [
      FILE_RECORD_ID,
    ]);
    expect(chunks.rows).toHaveLength(0);

    // In-flight embed job canceled (re-chunk will enqueue fresh jobs).
    const job = await db.query<JobRow>('SELECT state, chunk_id FROM job_queue WHERE id = $1', [
      EMBED_JOB_ID,
    ]);
    expect(job.rows[0]?.state).toBe('canceled');

    // The bytes really landed on disk.
    const onDisk = await fsPromises.readFile(path.join(rootPath, 'src', 'indexed.ts'), 'utf8');
    expect(onDisk).toBe(newContent);
  });

  it('no-ops (no error, no spurious row) when the written path is NOT indexed', async () => {
    const tools = buildDesktopAssistantTools(runtime());
    const writeTool = tools['brainstrike.writeWorkspaceFile'];

    const result = (await writeTool?.execute?.({
      path: '/src/not-indexed.ts',
      content: 'export const fresh = true;\n',
    })) as { bytesWritten: number } | undefined;

    expect(result?.bytesWritten).toBeGreaterThan(0);

    // No file_records row was invented for the un-indexed path.
    const rows = await db.query('SELECT id FROM file_records WHERE path = $1', [
      'src/not-indexed.ts',
    ]);
    expect(rows.rows).toHaveLength(0);

    // The write itself still happened.
    const onDisk = await fsPromises.readFile(path.join(rootPath, 'src', 'not-indexed.ts'), 'utf8');
    expect(onDisk).toBe('export const fresh = true;\n');
  });

  it('still returns a successful edit when re-index enqueue throws (non-fatal, logged)', async () => {
    await fsPromises.mkdir(path.join(rootPath, 'src'), { recursive: true });
    await fsPromises.writeFile(path.join(rootPath, 'src', 'indexed.ts'), 'old', 'utf8');
    await seedIndexedFile('export const value = 1;\n');

    // Force the re-index path to throw at the DB layer: the handle's transaction
    // (the local-PGlite dispatch the trigger uses) rejects.
    const failing = {
      query: db.query.bind(db),
      transaction: vi.fn(async () => {
        throw new Error('boom: re-index transaction failed');
      }),
    };
    const dbMain = await import('../../db-main');
    vi.mocked(dbMain.getDatabase).mockResolvedValueOnce(failing as never);

    const tools = buildDesktopAssistantTools(runtime());
    const writeTool = tools['brainstrike.writeWorkspaceFile'];

    const newContent = 'export const value = 42;\n';
    const result = (await writeTool?.execute?.({
      path: `/${INDEXED_REL_PATH}`,
      content: newContent,
    })) as { bytesWritten: number } | undefined;

    // Edit succeeded despite the re-index failure.
    expect(result?.bytesWritten).toBe(Buffer.byteLength(newContent, 'utf8'));
    expect(failing.transaction).toHaveBeenCalled();
    const onDisk = await fsPromises.readFile(path.join(rootPath, 'src', 'indexed.ts'), 'utf8');
    expect(onDisk).toBe(newContent);
  });
});

describe('re-index on edit (stringReplaceWorkspaceFile)', () => {
  it('re-indexes an indexed file after a surgical string replace', async () => {
    await fsPromises.mkdir(path.join(rootPath, 'src'), { recursive: true });
    const original = 'export const value = 1;\nexport const keep = 2;\n';
    await fsPromises.writeFile(path.join(rootPath, 'src', 'indexed.ts'), original, 'utf8');
    await seedIndexedFile(original);

    const tools = buildDesktopAssistantTools(runtime());
    const replaceTool = tools['brainstrike.stringReplaceWorkspaceFile'];
    expect(replaceTool).toBeDefined();

    const result = (await replaceTool?.execute?.({
      path: `/${INDEXED_REL_PATH}`,
      oldStr: 'export const value = 1;',
      newStr: 'export const value = 4321;',
    })) as { replaced: boolean } | undefined;

    expect(result?.replaced).toBe(true);

    const expected = 'export const value = 4321;\nexport const keep = 2;\n';
    const record = await readFileRecord(FILE_RECORD_ID);
    expect(record?.content).toBe(expected);
    expect(record?.content_hash).not.toBe('stale-content-hash');
    expect(record?.chunks_processed_at).toBeNull();

    const job = await db.query<JobRow>('SELECT state FROM job_queue WHERE id = $1', [EMBED_JOB_ID]);
    expect(job.rows[0]?.state).toBe('canceled');

    const onDisk = await fsPromises.readFile(path.join(rootPath, 'src', 'indexed.ts'), 'utf8');
    expect(onDisk).toBe(expected);
  });

  it('no-ops when indexing is disabled (no workspace index embedding set)', async () => {
    await fsPromises.mkdir(path.join(rootPath, 'src'), { recursive: true });
    const original = 'const a = 1;\n';
    await fsPromises.writeFile(path.join(rootPath, 'src', 'indexed.ts'), original, 'utf8');
    await seedIndexedFile(original);

    // Runtime without a workspace index set → trigger must no-op even though a
    // matching file_records row exists for another set.
    const noIndexRuntime = {
      workspaceRoots: [{ rootId: ROOT_ID, displayName: 'Project', path: rootPath }],
    } as unknown as RuntimeData;

    const tools = buildDesktopAssistantTools(noIndexRuntime);
    const replaceTool = tools['brainstrike.stringReplaceWorkspaceFile'];

    const result = (await replaceTool?.execute?.({
      path: `/${INDEXED_REL_PATH}`,
      oldStr: 'const a = 1;',
      newStr: 'const a = 2;',
    })) as { replaced: boolean } | undefined;

    expect(result?.replaced).toBe(true);

    // file_records row untouched (still the seeded stale hash; not re-indexed).
    const record = await readFileRecord(FILE_RECORD_ID);
    expect(record?.content_hash).toBe('stale-content-hash');
    expect(record?.chunks_processed_at).not.toBeNull();
    // But the on-disk edit still happened.
    const onDisk = await fsPromises.readFile(path.join(rootPath, 'src', 'indexed.ts'), 'utf8');
    expect(onDisk).toBe('const a = 2;\n');
  });
});
