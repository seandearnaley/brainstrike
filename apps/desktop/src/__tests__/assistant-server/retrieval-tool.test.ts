import type { RuntimeData } from '@brainstrike/agent';
import type { BrainstrikeDbTransactionClient } from '@brainstrike/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbQueryMock,
  embedMock,
  findByIdsMock,
  getDatabaseMock,
  getDatabaseRuntimeDiagnosticsMock,
  getKeyMock,
  loggerError,
  loggerWarn,
  resolveHostedProviderApiKeyMock,
  searchSimilarMock,
  tursoFindByIdsMock,
  tursoGetEmbeddingSetByIdMock,
  tursoSearchSimilarMock,
} = vi.hoisted(() => ({
  dbQueryMock: vi.fn(),
  embedMock: vi.fn(),
  findByIdsMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  getDatabaseRuntimeDiagnosticsMock: vi.fn(),
  getKeyMock: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  resolveHostedProviderApiKeyMock: vi.fn(),
  searchSimilarMock: vi.fn(),
  tursoFindByIdsMock: vi.fn(),
  tursoGetEmbeddingSetByIdMock: vi.fn(),
  tursoSearchSimilarMock: vi.fn(),
}));

vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../packages/agent/src/tools/workspace-index-retrieval')
  >('../../../../../packages/agent/src/tools/workspace-index-retrieval');
  class MockContextPacker {
    private readonly budgetTokens: number;

    constructor(options: { budgetTokens: number }) {
      this.budgetTokens = options.budgetTokens;
    }

    pack(
      chunks: Array<{
        content: string;
        endLine?: number;
        endOffset?: number;
        fileName?: string;
        filePath?: string;
        chunkIndex?: number;
        startLine?: number;
        startOffset?: number;
      }>
    ) {
      const totalTokens = chunks.length;
      return {
        totalTokens,
        budget: this.budgetTokens,
        remainingTokens: Math.max(this.budgetTokens - totalTokens, 0),
        skipped: 0,
        chunks: chunks.map((chunk, index) => ({
          ...chunk,
          rank: index + 1,
          tokenCount: 1,
          ...(chunk.startLine !== undefined && chunk.endLine !== undefined
            ? { lineRange: { start: chunk.startLine, end: chunk.endLine } }
            : {}),
          ...(chunk.startOffset !== undefined && chunk.endOffset !== undefined
            ? { offsets: { start: chunk.startOffset, end: chunk.endOffset } }
            : {}),
        })),
      };
    }
  }

  return {
    ContextPacker: MockContextPacker,
    createWorkspaceIndexUnavailableResult: actual.createWorkspaceIndexUnavailableResult,
    hasWorkspaceIndexRuntimeStatus: actual.hasWorkspaceIndexRuntimeStatus,
    normalizeOptionalText: actual.normalizeOptionalText,
    normalizeWorkspaceIndexText: actual.normalizeWorkspaceIndexText,
    resolveWorkspaceIndexEmbeddingSetId: actual.resolveWorkspaceIndexEmbeddingSetId,
    QueryEmbeddingSpaceInputSchema: {
      parse: (input: unknown) => input,
    },
    RetrievalContextInputSchema: {
      parse: (input: unknown) => input,
    },
  };
});

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  FileChunkRepository: class {
    searchSimilar(
      embedding: number[],
      options: {
        limit: number;
        threshold: number;
        embeddingSetId: string;
        filePaths?: string[];
        selectionSnapshotId?: string;
      }
    ) {
      return searchSimilarMock(embedding, options);
    }
  },
  FileRecordRepository: class {
    findByIds(ids: readonly string[]) {
      return findByIdsMock(ids);
    }
  },
  TursoEmbeddingSetsRepository: class {
    getById(id: string) {
      return tursoGetEmbeddingSetByIdMock(id);
    }
  },
  TursoFileChunkRepository: class {
    searchSimilar(
      embedding: number[],
      options: {
        limit: number;
        threshold: number;
        embeddingSetId: string;
        filePaths?: string[];
        selectionSnapshotId?: string;
      }
    ) {
      return tursoSearchSimilarMock(embedding, options);
    }
  },
  TursoFileRecordRepository: class {
    findByIds(ids: readonly string[]) {
      return tursoFindByIdsMock(ids);
    }
  },
}));

vi.mock('@brainstrike/embeddings/provider-core', () => ({
  CohereEmbeddingProvider: class {
    embed() {
      return embedMock();
    }
  },
  GoogleEmbeddingProvider: class {
    embed() {
      return embedMock();
    }
  },
  OpenAIEmbeddingProvider: class {
    embed() {
      return embedMock();
    }
  },
  VoyageEmbeddingProvider: class {
    embed() {
      return embedMock();
    }
  },
  hostedProviderRequiresApiKey: (provider: string) => !['ollama', 'lmstudio'].includes(provider),
  isHostedProvider: (provider: string) =>
    ['openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio'].includes(provider),
  isLocalProviderType: (provider: string) => ['local', 'transformers'].includes(provider),
  parseProviderModelKey: (modelKey: string) => ({ provider: modelKey.split(':')[0] }),
  resolveHostedProviderApiKey: resolveHostedProviderApiKeyMock,
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: () => ({
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@brainstrike/text-splitter', () => ({
  countTokensHeuristic: (value: string) => value.length,
}));

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
  getDatabaseRuntimeDiagnostics: getDatabaseRuntimeDiagnosticsMock,
}));

vi.mock('../../secrets', () => ({
  getSecretsService: () => ({
    getKey: getKeyMock,
  }),
}));

import {
  createQueryEmbeddingSpaceTool,
  createRetrievalTool,
  runQueryEmbeddingSpace,
} from '../../assistant-server/retrieval-tool';

describe('retrieval-tool', () => {
  const snapshotId = '550e8400-e29b-41d4-a716-446655440000';

  function createReadyTursoDiagnostics() {
    return {
      profileBootstrapReport: {
        checks: [
          {
            id: 'search.vector32-functions',
            label: 'Turso vector32 similarity functions are available',
            required: true,
            status: 'passed',
          },
        ],
        failure: null,
        phase: 'ready',
        profileId: 'profile-turso',
        ready: true,
        runtime: {
          engine: 'turso',
          host: 'electron-utility',
          persistence: 'filesystem',
        },
        search: {
          indexedSearch: 'available',
          message: 'test search ready',
          ownershipMode: 'split-search-index-store',
        },
        startedAt: '2026-06-29T11:00:00.000Z',
        updatedAt: '2026-06-29T11:00:01.000Z',
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getDatabaseRuntimeDiagnosticsMock.mockResolvedValue(createReadyTursoDiagnostics());
    getKeyMock.mockResolvedValue('test-api-key');
    resolveHostedProviderApiKeyMock.mockResolvedValue('fallback-api-key');
    embedMock.mockResolvedValue({ ok: true, value: { embedding: [0.25, 0.5] } });
    findByIdsMock.mockResolvedValue([
      {
        id: 'file-1',
        name: 'file.ts',
        path: '/repo/file.ts',
        tokenCount: 42,
        size: 123,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    tursoFindByIdsMock.mockResolvedValue([
      {
        id: 'file-1',
        name: 'file.ts',
        path: '/repo/file.ts',
        tokenCount: 42,
        size: 123,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    searchSimilarMock.mockResolvedValue([
      {
        chunk: {
          id: 'chunk-1',
          content: 'Hello world',
          tokenCount: 4,
          chunkIndex: 0,
          startLine: 10,
          endLine: 12,
          startOffset: 120,
          endOffset: 155,
          chunkType: 'code',
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
        },
        similarity: 0.9,
        rank: 1,
      },
    ]);
    tursoSearchSimilarMock.mockResolvedValue([
      {
        chunk: {
          id: 'chunk-1',
          content: 'Hello Turso world',
          tokenCount: 4,
          chunkIndex: 0,
          startLine: 10,
          endLine: 12,
          startOffset: 120,
          endOffset: 155,
          chunkType: 'code',
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
        },
        similarity: 0.9,
        rank: 1,
      },
    ]);
    tursoGetEmbeddingSetByIdMock.mockResolvedValue({
      id: 'explicit-set',
      modelKey: 'openai:text-embedding-3-small',
      modelId: 'text-embedding-3-small',
      dimensions: 2,
      distance: 'cosine',
      createdAt: new Date().toISOString(),
    });

    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'openai:text-embedding-3-small',
              modelId: 'text-embedding-3-small',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO selection_snapshots')) {
        return { rows: [{ id: snapshotId }] };
      }
      return { rows: [] };
    });

    getDatabaseMock.mockResolvedValue({ query: dbQueryMock });
  });

  it('fails explicitly instead of running PGlite vector retrieval against Turso', async () => {
    getDatabaseMock.mockResolvedValueOnce({
      capabilities: { liveQuery: false },
      query: dbQueryMock,
    });
    getDatabaseRuntimeDiagnosticsMock.mockResolvedValueOnce({
      profileBootstrapReport: {
        ...createReadyTursoDiagnostics().profileBootstrapReport,
        checks: [],
      },
    });

    await expect(
      runQueryEmbeddingSpace(
        {
          query: 'Where is assistant retrieval wired?',
          embeddingSetId: 'explicit-set',
        },
        {
          workspaceIndexEmbeddingSetId: 'workspace-index-set',
          workspaceIndexingEnabled: true,
          workspaceIndexStatusState: 'idle',
        }
      )
    ).rejects.toThrow('brainstrike.queryEmbeddingSpace requires a ready Turso bootstrap report');
    expect(dbQueryMock).not.toHaveBeenCalled();
    expect(searchSimilarMock).not.toHaveBeenCalled();
    expect(tursoSearchSimilarMock).not.toHaveBeenCalled();
  });

  it('runs Turso vector retrieval only when the bootstrap vector check passed', async () => {
    getDatabaseMock.mockResolvedValueOnce({
      capabilities: { liveQuery: false },
      query: dbQueryMock,
      transaction: vi.fn(),
      exec: vi.fn(),
    });

    const result = await runQueryEmbeddingSpace(
      {
        query: 'Where is assistant retrieval wired?',
        embeddingSetId: 'explicit-set',
      },
      {
        workspaceIndexEmbeddingSetId: 'workspace-index-set',
        workspaceIndexingEnabled: true,
        workspaceIndexStatusState: 'idle',
      }
    );

    expect(result.embeddingSetId).toBe('explicit-set');
    expect(getDatabaseRuntimeDiagnosticsMock).toHaveBeenCalledTimes(1);
    expect(tursoGetEmbeddingSetByIdMock).toHaveBeenCalledWith('explicit-set');
    expect(tursoSearchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'explicit-set',
    });
    expect(tursoFindByIdsMock).toHaveBeenCalledWith(['file-1']);
    expect(searchSimilarMock).not.toHaveBeenCalled();
    expect(findByIdsMock).not.toHaveBeenCalled();
  });

  it('creates Turso selection snapshots inside a transaction for large file-path filters', async () => {
    const transactionExecMock = vi.fn(async () => undefined);
    const transactionClient: BrainstrikeDbTransactionClient = {
      exec: transactionExecMock,
      query: dbQueryMock as BrainstrikeDbTransactionClient['query'],
    };
    const transactionMock = vi.fn(
      async <TResult>(
        callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
      ): Promise<TResult> => callback(transactionClient)
    );
    getDatabaseMock.mockResolvedValueOnce({
      capabilities: { liveQuery: false },
      exec: vi.fn(),
      query: dbQueryMock,
      transaction: transactionMock,
    });
    const filePaths = Array.from({ length: 501 }, (_, index) => `file-${index}.ts`);

    const result = await runQueryEmbeddingSpace(
      {
        query: 'Where is assistant retrieval wired?',
        embeddingSetId: 'explicit-set',
        filePaths,
      },
      {
        workspaceIndexEmbeddingSetId: 'workspace-index-set',
        workspaceIndexingEnabled: true,
        workspaceIndexStatusState: 'idle',
      }
    );

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(result.selectionSnapshotId).toEqual(
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    );
    expect(transactionExecMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('DELETE FROM selection_snapshots')
    );
    expect(transactionExecMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO selection_snapshots'),
      [result.selectionSnapshotId, expect.stringMatching(/Z$/)]
    );
    expect(transactionExecMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO selection_snapshot_files'),
      expect.arrayContaining([result.selectionSnapshotId, 'file-0.ts'])
    );
    expect(tursoSearchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'explicit-set',
      selectionSnapshotId: result.selectionSnapshotId,
    });
    expect(tursoSearchSimilarMock.mock.calls[0]?.[1]).not.toHaveProperty('filePaths');
    expect(searchSimilarMock).not.toHaveBeenCalled();
  });

  it('retrieves and packs context with inline file paths', async () => {
    const tool = createRetrievalTool({
      embeddingSetId: 'set-1',
      tokenBudget: 10,
      selectionFilePaths: ['/repo/file.ts'],
    });

    const result = await tool.execute({
      context: {
        query: '  Hello  ',
        embeddingSetId: 'set-1',
        filePaths: ['/repo/file.ts'],
      },
    });

    expect(result.query).toBe('Hello');
    expect(result.embeddingSetId).toBe('set-1');
    expect(result.limit).toBe(20);
    expect(result.threshold).toBe(0.3);
    expect(result.totalTokens).toBe(1);
    expect(result.context).toContain('Source 1: /repo/file.ts:10-12 (chunk 0)');
    expect(result.context).toContain('Hello world');
    expect(result.chunkContentIncludedInContext).toBe(true);
    expect(result.chunks[0]).not.toHaveProperty('content');
    expect(result.chunks[0]?.lineRange).toEqual({ start: 10, end: 12 });
    expect(result.chunks[0]?.offsets).toEqual({ start: 120, end: 155 });
    expect(result.selectionSnapshotId).toBeUndefined();

    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'set-1',
      filePaths: ['/repo/file.ts'],
    });
    expect(loggerWarn).not.toHaveBeenCalledWith('Embedding dimension mismatch', expect.anything());
  });

  it('uses the workspace index embedding set when no explicit or runtime set is provided', async () => {
    const tool = createRetrievalTool({
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexStatusState: 'idle',
    });

    const result = await tool.execute({
      context: {
        query: 'Where is assistant retrieval wired?',
      },
    });

    expect(result.embeddingSetId).toBe('workspace-index-set');
    expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'), [
      'workspace-index-set',
    ]);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'workspace-index-set',
    });
  });

  it('lets retrieveContext input override active runtime context', async () => {
    const tool = createRetrievalTool({
      embeddingSetId: 'active-set',
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexStatusState: 'idle',
    });

    const result = await tool.execute({
      context: {
        query: 'Where is assistant retrieval wired?',
        embeddingSetId: 'model-supplied-set',
      },
    });

    expect(result.embeddingSetId).toBe('model-supplied-set');
    expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'), [
      'model-supplied-set',
    ]);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'model-supplied-set',
    });
  });

  it('lets an explicit embedding set override the workspace index default', async () => {
    const tool = createRetrievalTool({
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexStatusState: 'idle',
    });

    const result = await tool.execute({
      context: {
        query: 'Where is assistant retrieval wired?',
        embeddingSetId: 'explicit-set',
      },
    });

    expect(result.embeddingSetId).toBe('explicit-set');
    expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'), [
      'explicit-set',
    ]);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'explicit-set',
    });
  });

  it('lets queryEmbeddingSpace input override active runtime context', async () => {
    const result = await runQueryEmbeddingSpace(
      {
        query: 'Where is assistant retrieval wired?',
        embeddingSetId: 'explicit-set',
      },
      {
        embeddingSetId: 'active-set',
        workspaceIndexEmbeddingSetId: 'workspace-index-set',
        workspaceIndexingEnabled: true,
        workspaceIndexStatusState: 'idle',
      }
    );

    expect(result.embeddingSetId).toBe('explicit-set');
    expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'), [
      'explicit-set',
    ]);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'explicit-set',
    });
  });

  it('returns structured workspace index status when the default workspace index is blocked', async () => {
    const tool = createRetrievalTool({
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexingPaused: false,
      workspaceIndexStatusState: 'blocked',
      workspaceIndexBlockedReason: 'missing-provider-key',
      workspaceIndexLastError: 'OpenAI key is required for Workspace Index.',
      workspaceIndexQueueProgress: {
        failed: 1,
        pending: 3,
        processed: 7,
        totalQueued: 11,
        lastError: 'provider key unavailable',
      },
    });

    const result = await tool.execute({
      context: {
        query: 'Where is assistant retrieval wired?',
      },
    });

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'workspace-index-blocked',
      message: 'Workspace Index is blocked: missing-provider-key.',
      query: 'Where is assistant retrieval wired?',
      workspaceIndex: {
        blockedReason: 'missing-provider-key',
        embeddingSetId: 'workspace-index-set',
        enabled: true,
        lastError: 'OpenAI key is required for Workspace Index.',
        paused: false,
        queueProgress: {
          failed: 1,
          lastError: 'provider key unavailable',
          pending: 3,
          processed: 7,
          totalQueued: 11,
        },
        statusState: 'blocked',
      },
    });
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('does not require API keys for local runtime embedding providers', async () => {
    getKeyMock.mockResolvedValue(undefined);
    resolveHostedProviderApiKeyMock.mockResolvedValue(undefined);
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'ollama::nomic-embed-text',
              modelId: 'nomic-embed-text',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const result = await tool.execute({
      context: { query: 'hello', embeddingSetId: 'set-1' },
    });

    expect(result.embeddingSetId).toBe('set-1');
    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('ollama');
  });

  it('supports lmstudio runtime embedding providers without API keys', async () => {
    getKeyMock.mockResolvedValue(undefined);
    resolveHostedProviderApiKeyMock.mockResolvedValue(undefined);
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'lmstudio::text-embedding-model',
              modelId: 'text-embedding-model',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const result = await tool.execute({
      context: { query: 'hello', embeddingSetId: 'set-1' },
    });

    expect(result.embeddingSetId).toBe('set-1');
    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('lmstudio');
  });

  it('uses the embedding host for local embedding set queries', async () => {
    const queryEmbeddingMock = vi.fn().mockResolvedValue([0.125, 0.75]);
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              modelId: 'Xenova/all-MiniLM-L6-v2',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool(
      { embeddingSetId: 'set-1' },
      { embeddingHostManager: { queryEmbedding: queryEmbeddingMock } }
    );
    const result = await tool.execute({
      context: { query: 'where is database config', embeddingSetId: 'set-1' },
    });

    expect(result.embeddingSetId).toBe('set-1');
    expect(queryEmbeddingMock).toHaveBeenCalledWith({
      dimensions: 2,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'where is database config',
    });
    expect(embedMock).not.toHaveBeenCalled();
    expect(searchSimilarMock).toHaveBeenCalledWith([0.125, 0.75], expect.anything());
  });

  it('surfaces a safe error when local embedding host is unavailable', async () => {
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              modelId: 'Xenova/all-MiniLM-L6-v2',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { query: 'where is database config', embeddingSetId: 'set-1' },
      })
    ).rejects.toThrow('Local embedding query host is unavailable.');
  });

  it('creates a selection snapshot when file paths exceed limit', async () => {
    getKeyMock.mockResolvedValue(undefined);
    const filePaths = Array.from({ length: 501 }, (_, index) => `file-${index}.ts`);

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const result = await tool.execute({
      context: {
        query: 'query',
        embeddingSetId: 'set-1',
        filePaths,
      },
    });

    expect(result.selectionSnapshotId).toBe(snapshotId);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'set-1',
      selectionSnapshotId: snapshotId,
    });
    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('openai');
  });

  it('rejects when embedding dimensions do not match active set', async () => {
    embedMock.mockResolvedValueOnce({ ok: true, value: { embedding: [0.25] } });
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { query: 'hello', embeddingSetId: 'set-1' },
      })
    ).rejects.toThrow('Embedding dimensions do not match the active set.');

    expect(loggerWarn).toHaveBeenCalledWith('Embedding dimension mismatch', {
      expected: 2,
      actual: 1,
    });
  });

  it('returns empty context when no chunks are found', async () => {
    searchSimilarMock.mockResolvedValueOnce([]);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    const result = await tool.execute({
      context: { query: 'hello', embeddingSetId: 'set-1' },
    });

    expect(result.context).toBe('');
    expect(result.chunks).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it('reports and skips chunks missing source ranges', async () => {
    searchSimilarMock.mockResolvedValueOnce([
      {
        chunk: {
          id: 'chunk-old',
          content: 'Old chunk without range',
          tokenCount: 2,
          chunkIndex: 0,
          chunkType: 'code',
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
        },
        similarity: 0.91,
        rank: 1,
      },
      {
        chunk: {
          id: 'chunk-new',
          content: 'Line-aware chunk',
          tokenCount: 3,
          chunkIndex: 1,
          startLine: 20,
          endLine: 21,
          startOffset: 200,
          endOffset: 230,
          chunkType: 'code',
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
        },
        similarity: 0.9,
        rank: 2,
      },
    ]);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    const result = await tool.execute({
      context: { query: 'hello', embeddingSetId: 'set-1' },
    });

    expect(result.context).toContain('Line-aware chunk');
    expect(result.context).not.toContain('Old chunk without range');
    expect(result.chunks).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedForMissingSourceRange).toBe(1);
    expect(result.skippedSourceRangeChunks).toEqual([
      { chunkId: 'chunk-old', chunkIndex: 0, fileRecordId: 'file-1' },
    ]);
    expect(loggerWarn).toHaveBeenCalledWith('Some retrieved chunks are missing source ranges', {
      retrievedChunks: 2,
      skippedForMissingSourceRange: 1,
    });
  });

  it('throws a safe rebuild hint when all retrieved chunks are missing source ranges', async () => {
    searchSimilarMock.mockResolvedValueOnce([
      {
        chunk: {
          id: 'chunk-old',
          content: 'Old chunk without range',
          tokenCount: 2,
          chunkIndex: 0,
          chunkType: 'code',
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
        },
        similarity: 0.91,
        rank: 1,
      },
    ]);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({ context: { query: 'hello', embeddingSetId: 'set-1' } })
    ).rejects.toThrow(
      'Retrieved chunks are missing source line metadata. Rebuild the embedding space.'
    );
    expect(loggerWarn).toHaveBeenCalledWith('All retrieved chunks are missing source ranges', {
      skippedForMissingSourceRange: 1,
    });
  });

  it('preserves the safe embedding-generation failure message', async () => {
    embedMock.mockResolvedValueOnce({ ok: false, error: new Error('provider down') });
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({ context: { query: 'hello', embeddingSetId: 'set-1' } })
    ).rejects.toThrow('Unable to generate query embeddings for retrieval.');
  });

  it('continues when snapshot cleanup fails', async () => {
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('DELETE FROM selection_snapshots')) {
        throw new Error('cleanup failed');
      }
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'openai:text-embedding-3-small',
              modelId: 'text-embedding-3-small',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO selection_snapshots')) {
        return { rows: [{ id: snapshotId }] };
      }
      return { rows: [] };
    });

    const filePaths = Array.from({ length: 501 }, (_, index) => `file-${index}.ts`);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    const result = await tool.execute({
      context: {
        query: 'query',
        embeddingSetId: 'set-1',
        filePaths,
      },
    });

    expect(result.selectionSnapshotId).toBe(snapshotId);
  });

  it('rejects invalid selection snapshot ids', async () => {
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: {
          query: 'hello',
          embeddingSetId: 'set-1',
          selectionSnapshotId: 'not-a-uuid',
        },
      })
    ).rejects.toThrow('Selection snapshot reference is invalid.');
  });

  it('rejects oversized selection file path lists', async () => {
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const filePaths = Array.from({ length: 5001 }, (_, index) => `file-${index}.ts`);

    await expect(
      tool.execute({
        context: {
          query: 'hello',
          embeddingSetId: 'set-1',
          filePaths,
        },
      })
    ).rejects.toThrow('Selection exceeds retrieval limits.');
  });

  it('surfaces safe errors when embedding set lookup fails', async () => {
    dbQueryMock.mockRejectedValueOnce(new Error('db exploded'));
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { query: 'hello', embeddingSetId: 'set-1' },
      })
    ).rejects.toThrow('Unable to load embedding set metadata.');
  });

  it('surfaces safe errors for missing embedding set', async () => {
    const tool = createRetrievalTool(undefined);

    await expect(
      tool.execute({
        context: { query: 'hello' },
      })
    ).rejects.toThrow('Select an active embedding set to enable retrieval.');
  });

  it('surfaces safe query-embedding-space selection guidance from the tool factory', async () => {
    const tool = createQueryEmbeddingSpaceTool(undefined);

    await expect(
      tool.execute({
        context: { query: 'hello' },
      })
    ).rejects.toThrow('Select an embedding space before querying semantic context.');
  });

  it('sanitizes unexpected retrieval errors', async () => {
    searchSimilarMock.mockRejectedValueOnce(new Error('bad'));
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { query: 'hello', embeddingSetId: 'set-1' },
      })
    ).rejects.toThrow('Unable to retrieve context right now. Try again.');
  });
});

describe('retrieval-tool multi-root', () => {
  const ROOTED_RUNTIME = {
    workspaceRoots: [
      { rootId: 'root-a', displayName: 'ProjectA', path: '/work/ProjectA' },
      { rootId: 'root-b', displayName: 'ProjectB', path: '/work/ProjectB' },
    ],
  } as unknown as RuntimeData;

  beforeEach(() => {
    vi.clearAllMocks();
    getKeyMock.mockResolvedValue('test-api-key');
    resolveHostedProviderApiKeyMock.mockResolvedValue('fallback-api-key');
    embedMock.mockResolvedValue({ ok: true, value: { embedding: [0.25, 0.5] } });
    findByIdsMock.mockResolvedValue([
      { id: 'file-1', name: 'file.ts', path: 'src/file.ts', tokenCount: 42 },
    ]);
    searchSimilarMock.mockResolvedValue([
      {
        chunk: {
          id: 'chunk-1',
          content: 'Hello world',
          tokenCount: 4,
          chunkIndex: 0,
          startLine: 10,
          endLine: 12,
          startOffset: 120,
          endOffset: 155,
          chunkType: 'code',
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
        },
        similarity: 0.9,
        rank: 1,
      },
    ]);
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'openai:text-embedding-3-small',
              modelId: 'text-embedding-3-small',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      // Root-label lookup (aliased columns mirror the real query).
      if (sql.includes('FROM file_records')) {
        return { rows: [{ id: 'file-1', rootId: 'root-a', rootName: 'ProjectA' }] };
      }
      return { rows: [] };
    });
    getDatabaseMock.mockResolvedValue({ query: dbQueryMock });
  });

  it('labels retrieved chunks and the context string with their workspace root', async () => {
    const result = await runQueryEmbeddingSpace(
      { query: 'hello', embeddingSetId: 'set-1' },
      ROOTED_RUNTIME
    );
    if ('status' in result) {
      throw new Error('expected a retrieval result');
    }
    expect(result.context).toContain('ProjectA');
    expect(result.chunks[0]?.metadata?.rootName).toBe('ProjectA');
    expect(result.chunks[0]?.metadata?.rootId).toBe('root-a');
  });

  it('scopes retrieval to the resolved root when `root` is provided', async () => {
    await runQueryEmbeddingSpace(
      { query: 'hello', embeddingSetId: 'set-1', root: 'ProjectB' },
      ROOTED_RUNTIME
    );
    expect(searchSimilarMock).toHaveBeenCalledWith(
      [0.25, 0.5],
      expect.objectContaining({ rootId: 'root-b' })
    );
  });

  it('errors clearly when `root` names a folder that is not open', async () => {
    await expect(
      runQueryEmbeddingSpace(
        { query: 'hello', embeddingSetId: 'set-1', root: 'Nope' },
        ROOTED_RUNTIME
      )
    ).rejects.toThrow(/no folder "Nope"/i);
  });
});
