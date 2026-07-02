import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FileChunkInsert,
  type FileRecord,
  TursoEmbeddingSetsRepository,
  TursoFileChunkRepository,
  TursoFileRecordRepository,
  TursoJobQueue,
} from '@brainstrike/db';
import { createTursoOwnerClient, type TursoOwnerClient } from '@brainstrike/db/turso/owner-client';
import { applyTursoSchemaBaseline } from '@brainstrike/db/turso/schema-baseline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DbHostRequest,
  DbHostResponseEnvelope,
  DbHostToMainMessage,
} from '../../db-host-protocol';

interface ParentPortMock {
  readonly on: (event: 'message', listener: (message: unknown) => void) => ParentPortMock;
  readonly postMessage: ReturnType<typeof vi.fn>;
}

const dbMainMocks = vi.hoisted(() => ({
  closeDatabase: vi.fn(),
  getDatabase: vi.fn(),
  getDatabaseDiagnostics: vi.fn(() => ({ hasDatabaseHandle: true })),
  initializeMainDatabaseWithBootstrapReport: vi.fn(),
  resetLocalDatabase: vi.fn(),
}));

vi.mock('../../db-main', () => dbMainMocks);

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

function restoreParentPort(): void {
  if (originalParentPortDescriptor) {
    Object.defineProperty(process, 'parentPort', originalParentPortDescriptor);
    return;
  }

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

function installParentPortMock(): {
  readonly listeners: readonly ((message: unknown) => void)[];
  readonly parentPort: ParentPortMock;
} {
  const listeners: ((message: unknown) => void)[] = [];
  const parentPort: ParentPortMock = {
    on: vi.fn((event: 'message', listener: (message: unknown) => void) => {
      if (event === 'message') {
        listeners.push(listener);
      }
      return parentPort;
    }),
    postMessage: vi.fn(),
  };

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: parentPort,
    writable: true,
  });

  return { listeners, parentPort };
}

function createReadyTursoBootstrapReport() {
  const checks = [
    'store.open',
    'primary-store.mvcc',
    'schema.baseline',
    'search.grep-content-grams',
    'search.vector32-functions',
    'search.ownership',
    'store.close',
  ].map((id) => ({
    id,
    label: id,
    required: true,
    status: 'passed',
  }));

  return {
    checks,
    failure: null,
    phase: 'ready',
    profileId: 'default',
    ready: true,
    runtime: {
      engine: 'turso',
      host: 'electron-utility',
      persistence: 'filesystem',
    },
    startedAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:01.000Z',
  };
}

function sendRequest(
  listener: ((message: unknown) => void) | undefined,
  id: string,
  request: DbHostRequest
): void {
  if (!listener) {
    throw new Error('DB host entry did not register a message listener.');
  }
  listener({
    data: {
      id,
      kind: 'request',
      request,
    },
  });
}

async function waitForResponse(
  parentPort: ParentPortMock,
  id: string
): Promise<DbHostResponseEnvelope> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const message = parentPort.postMessage.mock.calls
      .map(([posted]) => posted as DbHostToMainMessage)
      .find(
        (posted): posted is DbHostResponseEnvelope => posted.kind === 'response' && posted.id === id
      );
    if (message) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for DB host response: ${id}`);
}

function createRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    content: 'const answer = 42;',
    contentHash: 'hash-file-1',
    createdAt: '2026-06-30T09:50:00.000Z',
    id: 'file-1',
    name: 'index.ts',
    path: 'src/index.ts',
    size: 42,
    tokenCount: 8,
    updatedAt: '2026-06-30T09:50:00.000Z',
    ...overrides,
  };
}

function createChunk(overrides: Partial<FileChunkInsert> = {}): FileChunkInsert {
  return {
    chunkIndex: 0,
    chunkSize: 18,
    chunkType: 'code',
    content: 'const answer = 42;',
    contentHash: 'hash-chunk-1',
    createdAt: '2026-06-30T09:55:00.000Z',
    fileRecordId: 'file-1',
    id: 'chunk-1',
    tokenCount: 4,
    updatedAt: '2026-06-30T09:55:00.000Z',
    ...overrides,
  };
}

async function readStatsRow(client: TursoOwnerClient, embeddingSetId: string) {
  const result = await client.query<{
    chunk_count: number | string;
    dirty: number | string;
    embedded_chunk_count: number | string;
    file_count: number | string;
    pending_chunk_count: number | string;
  }>(
    `SELECT file_count, chunk_count, embedded_chunk_count, pending_chunk_count, dirty
       FROM collection_indexing_stats
      WHERE embedding_set_id = ?`,
    [embeddingSetId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    chunk_count: Number(row.chunk_count),
    dirty: Number(row.dirty),
    embedded_chunk_count: Number(row.embedded_chunk_count),
    file_count: Number(row.file_count),
    pending_chunk_count: Number(row.pending_chunk_count),
  };
}

describe('db-host-entry Turso owner requests', () => {
  beforeEach(() => {
    vi.resetModules();
    dbMainMocks.closeDatabase.mockReset();
    dbMainMocks.getDatabase.mockReset();
    dbMainMocks.getDatabaseDiagnostics.mockReset();
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockReset();
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockResolvedValue({
      bootstrapReport: createReadyTursoBootstrapReport(),
      capabilities: { liveQuery: false },
      initialized: true,
    });
    dbMainMocks.resetLocalDatabase.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
    restoreParentPort();
  });

  it('clears Turso embeddings for a set through the DB-host vector queue action', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-vector-action-host-'));
    let client: TursoOwnerClient | undefined;
    try {
      client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
      await applyTursoSchemaBaseline(client);
      dbMainMocks.getDatabase.mockResolvedValue(client);
      const embeddingSetsRepository = new TursoEmbeddingSetsRepository(client);
      const fileRecordsRepository = new TursoFileRecordRepository(client);
      const chunkRepository = new TursoFileChunkRepository(client);
      const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
        'local::test-model',
        'test-model',
        3,
        'cosine'
      );
      await fileRecordsRepository.createWithContent(
        createRecord({ embeddingSetId: embeddingSet.id })
      );
      await chunkRepository.insertMany([
        createChunk({
          chunkIndex: 0,
          embedding: [0.1, 0.2, 0.3],
          embeddingHash: 'direct-embedding-hash',
          embeddingSetId: embeddingSet.id,
          id: 'chunk-direct',
        }),
        createChunk({
          chunkIndex: 1,
          embedding: [0.3, 0.2, 0.1],
          embeddingHash: 'inherited-embedding-hash',
          id: 'chunk-inherited',
        }),
      ]);
      const { listeners, parentPort } = installParentPortMock();
      await import('../../db-host-entry');

      sendRequest(listeners[0], 'clear-embeddings', {
        kind: 'turso:vector-queue:action',
        payload: {
          operation: 'clearEmbeddingsForSet',
          payload: { embeddingSetId: embeddingSet.id },
        },
      });

      await expect(waitForResponse(parentPort, 'clear-embeddings')).resolves.toMatchObject({
        ok: true,
        result: { cleared: 2 },
      });
      await expect(chunkRepository.findById('chunk-direct')).resolves.toMatchObject({
        embeddingSetId: embeddingSet.id,
      });
      await expect(chunkRepository.findById('chunk-direct')).resolves.not.toHaveProperty(
        'embedding'
      );
      await expect(chunkRepository.findById('chunk-inherited')).resolves.not.toHaveProperty(
        'embedding'
      );
      await expect(readStatsRow(client, embeddingSet.id)).resolves.toMatchObject({
        chunk_count: 2,
        dirty: 0,
        embedded_chunk_count: 0,
        file_count: 1,
        pending_chunk_count: 2,
      });
    } finally {
      await client?.close();
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it('drives Turso embedding worker queue and stats through the DB host owner path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-worker-host-'));
    let client: TursoOwnerClient | undefined;
    try {
      client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
      await applyTursoSchemaBaseline(client);
      dbMainMocks.getDatabase.mockResolvedValue(client);
      const embeddingSetsRepository = new TursoEmbeddingSetsRepository(client);
      const fileRecordsRepository = new TursoFileRecordRepository(client);
      const chunkRepository = new TursoFileChunkRepository(client);
      const queue = new TursoJobQueue(client);
      const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
        'local::test-model',
        'test-model',
        3,
        'cosine'
      );
      await fileRecordsRepository.createWithContent(
        createRecord({ embeddingSetId: embeddingSet.id })
      );
      await chunkRepository.insert(createChunk({ embeddingSetId: embeddingSet.id }));
      const job = await queue.enqueue({
        queue: 'embeddings',
        jobType: 'embed_chunk',
        payload: { chunkId: 'chunk-1', embeddingSetId: embeddingSet.id },
        runAt: '2026-06-30T10:00:00.000Z',
      });
      const { listeners, parentPort } = installParentPortMock();
      await import('../../db-host-entry');

      sendRequest(listeners[0], 'claim-many', {
        kind: 'turso:embedding-worker:queue',
        payload: {
          operation: 'claimMany',
          payload: {
            leaseMs: 60_000,
            limit: 1,
            now: '2026-06-30T10:01:00.000Z',
            queue: 'embeddings',
            workerId: 'worker-real-owner',
          },
        },
      });
      const claimResponse = await waitForResponse(parentPort, 'claim-many');

      expect(claimResponse).toMatchObject({
        ok: true,
        result: [
          expect.objectContaining({
            id: job.id,
            lease_token: expect.any(String),
            state: 'running',
            worker_id: 'worker-real-owner',
          }),
        ],
      });
      const [claimedJob] = claimResponse.ok
        ? (claimResponse.result as Array<{ lease_token: string }>)
        : [];

      sendRequest(listeners[0], 'complete-chunk', {
        kind: 'turso:embedding-worker:queue',
        payload: {
          operation: 'completeEmbeddingChunkBatch',
          payload: [
            {
              id: job.id,
              leaseToken: claimedJob.lease_token,
              chunkId: 'chunk-1',
              embedding: [0.1, 0.2, 0.3],
              embeddingHash: 'embedding-hash-host',
              embeddingSetId: embeddingSet.id,
            },
          ],
        },
      });

      await expect(waitForResponse(parentPort, 'complete-chunk')).resolves.toMatchObject({
        ok: true,
        result: [
          expect.objectContaining({
            id: job.id,
            state: 'succeeded',
          }),
        ],
      });
      await expect(chunkRepository.findById('chunk-1')).resolves.toMatchObject({
        embedding: [0.1, 0.2, 0.3],
        embeddingHash: 'embedding-hash-host',
        embeddingSetId: embeddingSet.id,
      });

      sendRequest(listeners[0], 'mark-dirty', {
        kind: 'turso:embedding-worker:stats',
        payload: {
          embeddingSetIds: [embeddingSet.id],
          operation: 'markDirty',
        },
      });
      await expect(waitForResponse(parentPort, 'mark-dirty')).resolves.toMatchObject({
        ok: true,
        result: undefined,
      });
      await expect(readStatsRow(client, embeddingSet.id)).resolves.toMatchObject({ dirty: 1 });

      sendRequest(listeners[0], 'refresh-stats', {
        kind: 'turso:embedding-worker:stats',
        payload: {
          embeddingSetIds: [embeddingSet.id],
          operation: 'refresh',
        },
      });

      await expect(waitForResponse(parentPort, 'refresh-stats')).resolves.toMatchObject({
        ok: true,
        result: undefined,
      });
      await expect(readStatsRow(client, embeddingSet.id)).resolves.toMatchObject({
        chunk_count: 1,
        dirty: 0,
        embedded_chunk_count: 1,
        file_count: 1,
        pending_chunk_count: 0,
      });
    } finally {
      await client?.close();
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
