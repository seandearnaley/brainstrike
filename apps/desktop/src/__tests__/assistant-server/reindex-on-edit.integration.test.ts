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

const { dbHolder, loggerErrorMock } = vi.hoisted(() => ({
  dbHolder: { db: null as unknown },
  loggerErrorMock: vi.fn(),
}));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => dbHolder.db),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
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

import { resetToolCallLoopGuards } from '@brainstrike/host-capabilities/native-tools';
// LEGACY-ONLY (BST-1980 C1): used only by the legacy edit-tool blocks below; deleted
// with `assistant-tools.ts` in C2.
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { createCheckpointReindexDeps } from '../../assistant-server/checkpoint-reindex-deps';
import { disposeLspServers } from '../../assistant-server/lsp-diagnostics';
import { requireToolExecute } from './_tool-test-helpers';

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
    workspaceIndexEmbeddingSetId: EMBEDDING_SET_ID,
    workspaceIndexingEnabled: true,
    workspaceRoots: [{ displayName: 'Project', path: rootPath, rootId: ROOT_ID }],
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
  resetToolCallLoopGuards();
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
  await disposeLspServers();
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

// LEGACY-ONLY (BST-1980 C1): the legacy edit tools' synchronous re-index
// (`legacy-native-tool-ports.ts` → `reindex-side-effects.ts`). The host binds no
// index port (`FileMutationPorts.index`: "Absent when the shell's index watches files
// itself"); Desktop's canonical producer (`canonical-ingestion` workspace-runtime
// watch pass → `applyManagedCacheBatch` replace in `native-canonical-catalog.ts`)
// owns edited-file freshness. The seams themselves stay covered above through the
// live rewind owner. Deleted with the legacy composition in C2.
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
    const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

    const newContent = 'export const value = 999;\n// edited by agent\n';
    const result = (await executeTool({
      content: newContent,
      path: `/${INDEXED_REL_PATH}`,
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
    const job = (await db.query('SELECT state, chunk_id FROM job_queue WHERE id = $1', [
      EMBED_JOB_ID,
    ])) as { rows: JobRow[] };
    expect(job.rows[0]?.state).toBe('canceled');

    // The bytes really landed on disk.
    const onDisk = await fsPromises.readFile(path.join(rootPath, 'src', 'indexed.ts'), 'utf8');
    expect(onDisk).toBe(newContent);
  });

  it('no-ops (no error, no spurious row) when the written path is NOT indexed', async () => {
    const tools = buildDesktopAssistantTools(runtime());
    const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

    const result = (await executeTool({
      content: 'export const fresh = true;\n',
      path: '/src/not-indexed.ts',
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
    const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

    const newContent = 'export const value = 42;\n';
    const result = (await executeTool({
      content: newContent,
      path: `/${INDEXED_REL_PATH}`,
    })) as { bytesWritten: number } | undefined;

    // Edit succeeded despite the re-index failure.
    expect(result?.bytesWritten).toBe(Buffer.byteLength(newContent, 'utf8'));
    expect(failing.transaction).toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Failed to re-index edited file; RAG index may be stale until next sync',
      expect.objectContaining({
        path: { redacted: true },
      })
    );
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(INDEXED_REL_PATH);
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(rootPath);
    const onDisk = await fsPromises.readFile(path.join(rootPath, 'src', 'indexed.ts'), 'utf8');
    expect(onDisk).toBe(newContent);
  });
});

// LEGACY-ONLY (BST-1980 C1): as above; deleted with the legacy composition in C2.
describe('re-index on edit (stringReplaceWorkspaceFile)', () => {
  it('re-indexes an indexed file after a surgical string replace', async () => {
    await fsPromises.mkdir(path.join(rootPath, 'src'), { recursive: true });
    const original = 'export const value = 1;\nexport const keep = 2;\n';
    await fsPromises.writeFile(path.join(rootPath, 'src', 'indexed.ts'), original, 'utf8');
    await seedIndexedFile(original);

    const tools = buildDesktopAssistantTools(runtime());
    const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

    const result = (await executeTool({
      newStr: 'export const value = 4321;',
      oldStr: 'export const value = 1;',
      path: `/${INDEXED_REL_PATH}`,
    })) as { replaced: boolean } | undefined;

    expect(result?.replaced).toBe(true);

    const expected = 'export const value = 4321;\nexport const keep = 2;\n';
    const record = await readFileRecord(FILE_RECORD_ID);
    expect(record?.content).toBe(expected);
    expect(record?.content_hash).not.toBe('stale-content-hash');
    expect(record?.chunks_processed_at).toBeNull();

    const job = (await db.query('SELECT state FROM job_queue WHERE id = $1', [EMBED_JOB_ID])) as {
      rows: JobRow[];
    };
    expect(job.rows[0]?.state).toBe('canceled');

    const onDisk = await fsPromises.readFile(path.join(rootPath, 'src', 'indexed.ts'), 'utf8');
    expect(onDisk).toBe(expected);
  });

  it('serializes the write AND the re-index of two concurrent same-file edits (no interleave)', async () => {
    await fsPromises.mkdir(path.join(rootPath, 'src'), { recursive: true });
    // Two non-overlapping anchors so each edit matches a UNIQUE location.
    const original = 'export const alpha = 1;\nexport const beta = 2;\n';
    await fsPromises.writeFile(path.join(rootPath, 'src', 'indexed.ts'), original, 'utf8');
    await seedIndexedFile(original);

    // Gate the FIRST re-index transaction open. While it is held, the OTHER
    // edit's WRITE must NOT land on disk — proving the write+reindex run as one
    // critical section under the per-file lock. If the re-index ran OUTSIDE the
    // lock, the first edit would release the lock after its write and the second
    // edit's write would flush while this transaction is still gated.
    //
    // The two edits race through `resolveWorkspaceWritePath` before requesting
    // the lock, so WHICH edit acquires the lock first is non-deterministic — the
    // assertions below are therefore order-agnostic (exactly ONE of the two
    // edits is applied mid-flight, never both).
    let releaseFirstTxn: (() => void) | undefined;
    const firstTxnGate = new Promise<void>((resolve) => {
      releaseFirstTxn = resolve;
    });
    let firstTxnEnteredResolve: (() => void) | undefined;
    const firstTxnEntered = new Promise<void>((resolve) => {
      firstTxnEnteredResolve = resolve;
    });
    let txnCount = 0;
    const transactionDb = db as unknown as {
      transaction<TResult>(fn: (tx: unknown) => Promise<TResult>): Promise<TResult>;
    };
    const gatedDb = {
      query: db.query.bind(db),
      transaction: async <TResult>(fn: (tx: unknown) => Promise<TResult>): Promise<TResult> => {
        txnCount += 1;
        if (txnCount === 1) {
          firstTxnEnteredResolve?.();
          await firstTxnGate;
        }
        return transactionDb.transaction(fn);
      },
    };
    dbHolder.db = gatedDb;

    const tools = buildDesktopAssistantTools(runtime());
    const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

    const editAlpha = executeTool({
      newStr: 'export const alpha = 111;',
      oldStr: 'export const alpha = 1;',
      path: `/${INDEXED_REL_PATH}`,
    }) as Promise<{ replaced: boolean }>;
    const editBeta = executeTool({
      newStr: 'export const beta = 222;',
      oldStr: 'export const beta = 2;',
      path: `/${INDEXED_REL_PATH}`,
    }) as Promise<{ replaced: boolean }>;

    // Wait until the FIRST edit's re-index transaction is in flight (so its write
    // already landed), then give the OTHER edit a generous window to acquire the
    // lock and write IF it could. With the re-index INSIDE the lock, the first
    // edit still holds the lock through its (gated) re-index, so the second stays
    // blocked and its write never lands here. With the re-index OUTSIDE the lock
    // (the bug), the second edit's write flushes within this window.
    await firstTxnEntered;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const midFlight = await fsPromises.readFile(path.join(rootPath, 'src', 'indexed.ts'), 'utf8');

    const alphaEdited = midFlight.includes('export const alpha = 111;');
    const betaEdited = midFlight.includes('export const beta = 222;');
    // EXACTLY ONE edit is applied mid-flight; the second is blocked on the lock.
    expect(alphaEdited !== betaEdited).toBe(true);
    if (alphaEdited) {
      // Alpha's edit acquired the lock first; beta's write must NOT have landed.
      expect(midFlight).toContain('export const beta = 2;');
    } else {
      // Beta's edit acquired the lock first; alpha's write must NOT have landed.
      expect(midFlight).toContain('export const alpha = 1;');
    }

    // Release the gated re-index; both edits now drain.
    releaseFirstTxn?.();
    const [resultAlpha, resultBeta] = await Promise.all([editAlpha, editBeta]);
    expect(resultAlpha?.replaced).toBe(true);
    expect(resultBeta?.replaced).toBe(true);

    // Both writes applied, with no lost update (independent of which ran first).
    const expected = 'export const alpha = 111;\nexport const beta = 222;\n';
    const onDisk = await fsPromises.readFile(path.join(rootPath, 'src', 'indexed.ts'), 'utf8');
    expect(onDisk).toBe(expected);

    // The indexed row is coherent with the final on-disk bytes (no stale row).
    const record = await readFileRecord(FILE_RECORD_ID);
    expect(record?.content).toBe(expected);
    expect(record?.content_hash).not.toBe('stale-content-hash');
    expect(record?.chunks_processed_at).toBeNull();

    // Restore the un-gated handle for afterEach cleanup.
    dbHolder.db = db;
  });

  it('no-ops when indexing is disabled (no workspace index embedding set)', async () => {
    await fsPromises.mkdir(path.join(rootPath, 'src'), { recursive: true });
    const original = 'const a = 1;\n';
    await fsPromises.writeFile(path.join(rootPath, 'src', 'indexed.ts'), original, 'utf8');
    await seedIndexedFile(original);

    // Runtime without a workspace index set → trigger must no-op even though a
    // matching file_records row exists for another set.
    const noIndexRuntime = {
      workspaceRoots: [{ displayName: 'Project', path: rootPath, rootId: ROOT_ID }],
    } as unknown as RuntimeData;

    const tools = buildDesktopAssistantTools(noIndexRuntime);
    const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

    const result = (await executeTool({
      newStr: 'const a = 2;',
      oldStr: 'const a = 1;',
      path: `/${INDEXED_REL_PATH}`,
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
