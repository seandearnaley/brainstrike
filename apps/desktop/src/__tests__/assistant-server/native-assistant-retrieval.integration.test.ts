// @vitest-environment node
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { afterEach, expect, it, vi } from 'vitest';
import { createIndexerConnection } from '../../../../../packages/indexer/dist/transport.js';
import {
  SqliteQueryClient,
  spawnQueryProcess,
} from '../../../../../packages/sqlite-query/dist/index.js';
import { createNativeScopedSearchCapability } from '../../native-scoped-search';

const pg = vi.hoisted(() => ({ files: vi.fn(), fts: vi.fn(), query: vi.fn(), vectors: vi.fn() }));
vi.mock('../../db-main', () => ({ getDatabase: async () => ({ query: pg.query }) }));
vi.mock('@brainstrike/db', async (original) => ({
  ...(await original<typeof import('@brainstrike/db')>()),
  FileChunkRepository: class {
    searchSimilar = pg.vectors;
    fullTextSearch = pg.fts;
  },
  FileRecordRepository: class {
    findByIds = pg.files;
  },
}));

import { runHybridSearch } from '../../assistant-server/hybrid-search-tool';
import { SEARCH_TOOL_EXECUTORS } from '../../assistant-server/native-tool-executors-search';
import { runQueryEmbeddingSpace } from '../../assistant-server/retrieval-tool';

const profile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  provider: 'local',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 256,
} as const;
const queryPlan = {
  inferencePlan: {
    device: 'wasm',
    dimensions: profile.dimensions,
    dtype: profile.dtype,
    modelId: profile.modelId,
    revision: profile.revision,
  },
  modelKey: `local::${profile.modelId}`,
} as const;
const collection = { embeddingSetId: 'selected', kind: 'collection' } as const;
const workspace = { kind: 'workspace', rootId: 'root' } as const;
const rootless = {
  embeddingSetId: 'selected',
  fileId: 'retained',
  profile,
  relativePath: null,
  rootId: null,
  sourcePath: null,
};
const rooted = {
  ...rootless,
  fileId: 'rooted',
  relativePath: 'source.txt',
  rootId: 'root',
  sourcePath: '/actual/root/source.txt',
};
const vector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
afterEach(() => vi.clearAllMocks());
it('composes production tools with the scoped SQLite writer and real separate qualified grep reader', async () => {
  const executable = process.env['SQLITE_QUERY_TEST_EXEC_PATH'];
  const nodeExecutable = process.env['INDEXER_TEST_EXEC_PATH'];
  if (!(executable && nodeExecutable)) {
    throw new Error('Explicit qualified query and indexer executables are required.');
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'native-assistant-retrieval-'));
  const dbPath = path.join(directory, 'index.sqlite');
  // Explicit Node process runs the public indexer; the qualified Electron parent
  // and query child share advanced IPC. The indexer channel carries JSON DTOs.
  const child = fork(
    fileURLToPath(
      new URL('../../../../../packages/indexer/dist/process-entry.js', import.meta.url)
    ),
    [],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      execArgv: [],
      execPath: nodeExecutable,
      serialization: 'json',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }
  );
  const connection = createIndexerConnection(
    {
      dbPath,
      embedding: { indexMode: 'text-only' },
      fileBindings: [rootless, rooted],
      rootIds: ['root'],
      scopes: [collection, workspace],
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 },
    {
      kill: () => child.kill(),
      onError: (listener) => {
        child.on('error', listener);
        return () => {
          child.off('error', listener);
        };
      },
      onExit: (listener) => {
        child.on('exit', listener);
        return () => {
          child.off('exit', listener);
        };
      },
      onMessage: (listener) => {
        child.on('message', listener);
        return () => {
          child.off('message', listener);
        };
      },
      send: (message) => {
        child.send(message);
      },
    }
  );
  try {
    const port = await connection.ready;
    for (const { profile: _profile, ...binding } of [rootless, rooted]) {
      const plan = await port.prepareScopedFile({
        profile,
        snapshot: {
          ...binding,
          content: 'native marker from actual SQLite',
          providedChunks: [
            {
              chunkIndex: 0,
              chunkSize: 384,
              chunkType: 'text',
              content: 'native marker from actual SQLite',
              contentHash: createHash('sha256')
                .update('native marker from actual SQLite')
                .digest('hex'),
              endLine: 1,
              endOffset: 'native marker from actual SQLite'.length,
              startLine: 1,
              startOffset: 0,
              tokenCount: 6,
            },
          ],
        },
      });
      await port.commitScopedFile({
        embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
        plan,
        profile,
      });
    }
    const capability = createNativeScopedSearchCapability({
      acquireIndexer: async () => port,
      getAuthority: async () => ({
        bindings: [rootless, rooted],
        collectionId: 'selected',
        generation: 1,
        profile,
        queryPlan,
        readiness: [
          { scanComplete: true, scope: collection },
          { scanComplete: true, scope: workspace },
        ],
        rootIds: ['root'],
      }),
      openQuery: () =>
        SqliteQueryClient.open({
          databasePath: dbPath,
          deadlineMs: 1000,
          spawn: () =>
            spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
          startupDeadlineMs: 5000,
        }),
      rebuild: async () => {
        throw new Error('Unexpected rebuild');
      },
    });
    pg.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('embedding_sets')
        ? [
            {
              dimensions: 384,
              distance: 'cosine',
              modelId: profile.modelId,
              modelKey: queryPlan.modelKey,
            },
          ]
        : [
            { id: 'retained', rootId: null, rootName: null },
            { id: 'rooted', rootId: 'root', rootName: 'Actual' },
          ],
    }));
    pg.files.mockResolvedValue([
      { id: 'retained', name: 'retained.txt', path: 'retained.txt', rootId: null },
      { id: 'rooted', name: 'source.txt', path: 'source.txt', rootId: 'root' },
    ]);
    const queryEmbedding = vi.fn(async () => vector);
    const signal = new AbortController().signal;
    const dependencies = {
      embeddingHostManager: { queryEmbedding },
      nativeIndexSearch: capability,
    };
    const semantic = await runQueryEmbeddingSpace(
      { embeddingSetId: 'selected', query: 'native marker' },
      undefined,
      dependencies,
      signal
    );
    expect(
      'chunks' in semantic &&
        semantic.chunks.map((chunk) => chunk.metadata?.['fileRecordId']).sort()
    ).toEqual(['retained', 'rooted']);
    const hybrid = await runHybridSearch(
      { embeddingSetId: 'selected', query: 'native marker', root: 'root' },
      { workspaceRoots: [{ displayName: 'Actual', path: '/actual/root', rootId: 'root' }] },
      dependencies,
      signal
    );
    expect(hybrid.results).toHaveLength(1);
    expect(hybrid.results[0]).toMatchObject({
      content: 'native marker from actual SQLite',
      fileName: 'source.txt',
      sourceCount: 3,
      vectorSimilarity: 1,
    });
    const entry = SEARCH_TOOL_EXECUTORS[NATIVE_TOOL_ID.hybridSearch]({
      dependencies,
      isLocalProvider: false,
      readFileCursorRegistry: {} as never,
      resolveActiveDomainCharBudget: () => 6000,
      resolvedDomainCharBudget: 6000,
      runtimeData: undefined,
    });
    if (!(entry && 'toModelOutput' in entry) || typeof entry.toModelOutput !== 'function') {
      throw new Error('Missing hybrid model projection');
    }
    const project = entry.toModelOutput;
    expect(() => project(hybrid)).not.toThrow();
    expect(queryEmbedding).toHaveBeenCalledWith(
      {
        dimensions: 384,
        inferencePlan: queryPlan.inferencePlan,
        modelId: profile.modelId,
        modelKey: queryPlan.modelKey,
        query: 'native marker',
      },
      { signal }
    );
    expect(pg.vectors).not.toHaveBeenCalled();
    expect(pg.fts).not.toHaveBeenCalled();
  } finally {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);
