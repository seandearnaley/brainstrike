/**
 * Workspace Index coherence after a checkpoint restore — REAL PGlite integration.
 *
 * Host rewind restores (`agent-host-platform/host-rewind-files.ts`) and checkpoint
 * undo feed every restored or deleted path to `createCheckpointReindexDeps(db).reindex`,
 * which re-indexes through the SAME entry point the background indexer uses
 * (`applyManagedCacheBatch` replace): stale chunks are deleted, in-flight
 * `embed_chunk` jobs are canceled, and the file_records row is marked un-chunked
 * (`chunks_processed_at = NULL`). Also proves the no-op paths and that a re-index
 * FAILURE is non-fatal. Host edit tools do not reindex here: the canonical producer
 * watches edited files (`e2e/host-thread-index-freshness.desktop.test.ts`).
 */

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbHolder, loggerErrorMock } = vi.hoisted(() => ({
  dbHolder: { db: null as unknown },
  loggerErrorMock: vi.fn(),
}));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => dbHolder.db),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      error: loggerErrorMock,
      info: vi.fn(),
      warn: vi.fn(),
    })),
  };
});

import { createCheckpointReindexDeps } from '../../assistant-server/checkpoint-reindex-deps';

const ROOT_ID = 'root-1';
const EMBEDDING_SET_ID = 'set-1';
const INDEXED_REL_PATH = 'src/indexed.ts';
const FILE_RECORD_ID = 'fr-indexed';
const CHUNK_ID = 'chunk-indexed-1';
const EMBED_JOB_ID = 'job-indexed-1';

let db: PGlite;
let rootPath: string;

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
  const result = (await db.query(
    'SELECT content, content_hash, chunks_processed_at, chunks_count FROM file_records WHERE id = $1',
    [id]
  )) as { rows: FileRecordRow[] };
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
  loggerErrorMock.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
  await fsPromises.rm(rootPath, { force: true, recursive: true });
});

/**
 * The live reindex owner: host rewind restores (`agent-host-platform/host-rewind-files.ts`)
 * feed every restored or deleted path to `createCheckpointReindexDeps(db).reindex`,
 * the same `triggerEditedFileReindex` / `triggerFileDeletionInvalidation` seams the
 * legacy edit tools called, against this real PGlite fixture. The edit tools
 * themselves no longer reindex on a host thread (no `FileMutationPorts.index`):
 * Desktop's canonical producer watches the edited files and replaces their rows.
 */
describe('checkpoint restore reindex (createCheckpointReindexDeps)', () => {
  /** The revert seam resolves the Workspace Index set by its system role. */
  async function markWorkspaceIndexSet(): Promise<void> {
    await db.query(`UPDATE embedding_sets SET system_role = 'workspace-index' WHERE id = $1`, [
      EMBEDDING_SET_ID,
    ]);
  }

  async function writeIndexedFile(content: string): Promise<string> {
    const absolutePath = path.join(rootPath, 'src', 'indexed.ts');
    await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsPromises.writeFile(absolutePath, content, 'utf8');
    return absolutePath;
  }

  function restoreAction(absolutePath: string, content: string, workspacePath: string) {
    return {
      absolutePath,
      content,
      kind: 'restore' as const,
      rootId: ROOT_ID,
      size: Buffer.byteLength(content, 'utf8'),
      workspacePath,
    };
  }

  it('re-indexes a restored indexed file: clears stale chunks, cancels jobs, marks un-chunked', async () => {
    await markWorkspaceIndexSet();
    await writeIndexedFile('old');
    await seedIndexedFile('export const value = 1;\n');

    // The restore already wrote the file's bytes; the seam re-indexes them.
    const restored = 'export const value = 999;\n// restored by rewind\n';
    const absolutePath = await writeIndexedFile(restored);
    const { reindex } = await createCheckpointReindexDeps(db);
    await reindex(restoreAction(absolutePath, restored, `/${INDEXED_REL_PATH}`));

    // file_records row was replaced: new content, fresh hash, marked un-chunked.
    const record = await readFileRecord(FILE_RECORD_ID);
    expect(record?.content).toBe(restored);
    expect(record?.content_hash).not.toBe('stale-content-hash');
    expect(record?.chunks_processed_at).toBeNull();
    expect(record?.chunks_count).toBe(0);

    // Stale chunk deleted.
    const chunks = await db.query('SELECT id FROM file_chunks WHERE file_record_id = $1', [
      FILE_RECORD_ID,
    ]);
    expect(chunks.rows).toHaveLength(0);

    // In-flight embed job canceled (re-chunk will enqueue fresh jobs).
    const job = (await db.query('SELECT state, chunk_id FROM job_queue WHERE id = $1', [
      EMBED_JOB_ID,
    ])) as { rows: JobRow[] };
    expect(job.rows[0]?.state).toBe('canceled');
  });

  it('no-ops (no error, no spurious row) when the restored path is NOT indexed', async () => {
    await markWorkspaceIndexSet();
    const content = 'export const fresh = true;\n';
    const absolutePath = path.join(rootPath, 'src', 'not-indexed.ts');
    await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsPromises.writeFile(absolutePath, content, 'utf8');
    const { reindex } = await createCheckpointReindexDeps(db);

    await expect(
      reindex(restoreAction(absolutePath, content, '/src/not-indexed.ts'))
    ).resolves.toBeUndefined();

    // No file_records row was invented for the un-indexed path.
    const rows = await db.query('SELECT id FROM file_records WHERE path = $1', [
      'src/not-indexed.ts',
    ]);
    expect(rows.rows).toHaveLength(0);
  });

  it('resolves (non-fatal, logged and redacted) when the re-index transaction throws', async () => {
    await markWorkspaceIndexSet();
    await writeIndexedFile('old');
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

    const restored = 'export const value = 42;\n';
    const absolutePath = await writeIndexedFile(restored);
    const { reindex } = await createCheckpointReindexDeps(db);
    await expect(
      reindex(restoreAction(absolutePath, restored, `/${INDEXED_REL_PATH}`))
    ).resolves.toBeUndefined();

    expect(failing.transaction).toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Failed to re-index edited file; RAG index may be stale until next sync',
      expect.objectContaining({
        path: { redacted: true },
      })
    );
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(INDEXED_REL_PATH);
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(rootPath);
    // The restored bytes are untouched by the failed re-index.
    expect(await fsPromises.readFile(absolutePath, 'utf8')).toBe(restored);
  });

  it('no-ops when no Workspace Index set exists (row untouched)', async () => {
    // The seeded set has no workspace-index system role: nothing is re-indexed.
    const original = 'const a = 1;\n';
    await writeIndexedFile(original);
    await seedIndexedFile(original);

    const restored = 'const a = 2;\n';
    const absolutePath = await writeIndexedFile(restored);
    const { reindex } = await createCheckpointReindexDeps(db);
    await reindex(restoreAction(absolutePath, restored, `/${INDEXED_REL_PATH}`));

    // file_records row untouched (still the seeded stale hash; not re-indexed).
    const record = await readFileRecord(FILE_RECORD_ID);
    expect(record?.content_hash).toBe('stale-content-hash');
    expect(record?.chunks_processed_at).not.toBeNull();
  });

  it('invalidates a deleted indexed file: removes its rows and cancels its embed jobs', async () => {
    await markWorkspaceIndexSet();
    await seedIndexedFile('export const value = 1;\n');
    const { reindex } = await createCheckpointReindexDeps(db);

    await reindex({ kind: 'delete', rootId: ROOT_ID, workspacePath: `/${INDEXED_REL_PATH}` });

    expect(await readFileRecord(FILE_RECORD_ID)).toBeUndefined();
    const chunks = await db.query('SELECT id FROM file_chunks WHERE file_record_id = $1', [
      FILE_RECORD_ID,
    ]);
    expect(chunks.rows).toHaveLength(0);
    const job = (await db.query('SELECT state FROM job_queue WHERE id = $1', [EMBED_JOB_ID])) as {
      rows: JobRow[];
    };
    expect(job.rows[0]?.state).toBe('canceled');
  });
});
