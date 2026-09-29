import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebE2ETestHooks } from '../web-e2e-test-hooks';

const usePGliteDatabaseMock = vi.hoisted(() => vi.fn());
const getEmbeddingQueueMock = vi.hoisted(() => vi.fn());
const runEmbeddingModelSwitchMemoryProbeMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: usePGliteDatabaseMock,
}));
vi.mock('@brainstrike/db/react', () => ({
  usePGliteDatabase: usePGliteDatabaseMock,
}));

vi.mock('../create-embedding-queue', () => ({
  getEmbeddingQueue: getEmbeddingQueueMock,
}));
vi.mock('../embedding-model-switch-memory-probe', () => ({
  runEmbeddingModelSwitchMemoryProbe: runEmbeddingModelSwitchMemoryProbeMock,
}));

interface TestDbHandle {
  readonly exec?: ReturnType<typeof vi.fn>;
  readonly query: ReturnType<typeof vi.fn>;
  readonly syncToFs?: ReturnType<typeof vi.fn>;
  readonly transaction?: ReturnType<typeof vi.fn>;
}

function setWebDriver(value: boolean): void {
  vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(value);
}

describe('WebE2ETestHooks', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, '__brainstrikeWebE2ETestHooks__');
    window.__brainstrikeEnableEmbeddingModelSwitchMemoryProbe__ = true;
    usePGliteDatabaseMock.mockReset();
    runEmbeddingModelSwitchMemoryProbeMock.mockReset();
    runEmbeddingModelSwitchMemoryProbeMock.mockResolvedValue({
      afterTeardown: { estimatedGpuBytes: 0, estimatedHeapBytes: 0, residentCount: 0 },
      beforeTeardown: {
        estimatedGpuBytes: 16,
        estimatedHeapBytes: 24,
        memoryEstimateUnavailableCount: 0,
        residentCount: 4,
      },
      disposedModels: ['wasm-b', 'wasm-cycle-5'],
      firstGpuEvictedModel: 'gpu-a',
      firstWasmEvictedModel: 'wasm-b',
      health: { failureCount: 0, lastFailure: null },
      residentLimitEvictionCount: 1,
    });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__brainstrikeWebE2ETestHooks__');
    Reflect.deleteProperty(window, '__brainstrikeEnableEmbeddingModelSwitchMemoryProbe__');
    vi.restoreAllMocks();
  });

  it('does not expose hooks outside webdriver automation', async () => {
    setWebDriver(false);
    window.__brainstrikeWebE2ETestHooks__ = {
      completeAssistantThreadRun: vi.fn(),
      createAssistantThreadRun: vi.fn(),
      dbPath: 'idb://old',
      linkResetProbeRowsToCollection: vi.fn(),
      qualifyDatabaseExtensions: vi.fn(),
      qualifyLocalEmbedding: vi.fn(),
      readAssistantThreadRunStatuses: vi.fn(),
      readAssistantThreads: vi.fn(),
      readFileRowCounts: vi.fn(),
      readModelEnabled: vi.fn(),
      readResetRowCounts: vi.fn(),
      runEmbeddingModelSwitchMemoryProbe: vi.fn(),
      seedFileRowsOnly: vi.fn(),
      seedResetProbeRows: vi.fn(),
      syncDatabase: vi.fn(),
    };
    usePGliteDatabaseMock.mockReturnValue({
      query: vi.fn(),
      syncToFs: vi.fn(),
    } satisfies TestDbHandle);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeUndefined();
    });
  });

  it('waits for the database handle before exposing hooks', async () => {
    setWebDriver(true);
    window.__brainstrikeWebE2ETestHooks__ = {
      completeAssistantThreadRun: vi.fn(),
      createAssistantThreadRun: vi.fn(),
      dbPath: 'idb://old',
      linkResetProbeRowsToCollection: vi.fn(),
      qualifyDatabaseExtensions: vi.fn(),
      qualifyLocalEmbedding: vi.fn(),
      readAssistantThreadRunStatuses: vi.fn(),
      readAssistantThreads: vi.fn(),
      readFileRowCounts: vi.fn(),
      readModelEnabled: vi.fn(),
      readResetRowCounts: vi.fn(),
      runEmbeddingModelSwitchMemoryProbe: vi.fn(),
      seedFileRowsOnly: vi.fn(),
      seedResetProbeRows: vi.fn(),
      syncDatabase: vi.fn(),
    };
    usePGliteDatabaseMock.mockReturnValue(null);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeUndefined();
    });
  });

  it('does not expose the model-switch probe without the explicit init flag', async () => {
    Reflect.deleteProperty(window, '__brainstrikeEnableEmbeddingModelSwitchMemoryProbe__');
    setWebDriver(true);
    usePGliteDatabaseMock.mockReturnValue({
      query: vi.fn(),
      syncToFs: vi.fn(),
    } satisfies TestDbHandle);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeDefined();
    });
    expect(
      window.__brainstrikeWebE2ETestHooks__?.runEmbeddingModelSwitchMemoryProbe
    ).toBeUndefined();
  });

  it('rechecks webdriver and init attestation when a captured probe hook runs', async () => {
    setWebDriver(true);
    usePGliteDatabaseMock.mockReturnValue({
      query: vi.fn(),
      syncToFs: vi.fn(),
    } satisfies TestDbHandle);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__?.runEmbeddingModelSwitchMemoryProbe).toBeTypeOf(
        'function'
      );
    });
    const runProbe = window.__brainstrikeWebE2ETestHooks__?.runEmbeddingModelSwitchMemoryProbe;
    if (!runProbe) {
      throw new Error('Expected the model-switch probe hook to be installed.');
    }

    setWebDriver(false);
    await expect(runProbe()).rejects.toThrow(
      'Embedding model-switch memory probe is restricted to webdriver automation.'
    );

    setWebDriver(true);
    Reflect.deleteProperty(window, '__brainstrikeEnableEmbeddingModelSwitchMemoryProbe__');
    await expect(runProbe()).rejects.toThrow(
      'Embedding model-switch memory probe requires the explicit init-script flag.'
    );
    expect(runEmbeddingModelSwitchMemoryProbeMock).not.toHaveBeenCalled();
  });

  it('exposes model state and durable sync helpers for webdriver tests', async () => {
    setWebDriver(true);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'thread-1',
            metadata: { color: 'rose', icon: 'bug' },
            resourceId: 'workspace-a',
            title: 'Debug reload',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ is_enabled: 'true' }] })
      .mockResolvedValueOnce({ rows: [{ is_enabled: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ extname: 'pg_textsearch' }, { extname: 'pg_trgm' }, { extname: 'vector' }],
      })
      .mockResolvedValueOnce({
        rows: [{ distance: 0, full_text_match: true }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ bm25_score: 0.5 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const syncToFs = vi.fn().mockResolvedValue(undefined);
    const add = vi.fn().mockResolvedValue({
      id: 'csp-embedding-qualification',
      metadata: {
        device: 'wasm',
        dimensions: 384,
        dtype: 'q4',
        fallbackApplied: false,
      },
      type: 'result',
      vectors: [new Float32Array(384).fill(0.25)],
    });
    getEmbeddingQueueMock.mockReturnValue({ add });
    const transaction = vi.fn(
      async (callback: (tx: TestDbHandle) => Promise<unknown>): Promise<unknown> =>
        callback({ query })
    );
    usePGliteDatabaseMock.mockReturnValue({
      query,
      syncToFs,
      transaction,
    } satisfies TestDbHandle);

    const { unmount } = render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__?.dbPath).toBe('idb://web-e2e-test');
    });

    await expect(window.__brainstrikeWebE2ETestHooks__?.readAssistantThreads()).resolves.toEqual([
      {
        id: 'thread-1',
        metadata: { color: 'rose', icon: 'bug' },
        resourceId: 'workspace-a',
        title: 'Debug reload',
      },
    ]);
    await expect(window.__brainstrikeWebE2ETestHooks__?.readModelEnabled('model-1')).resolves.toBe(
      true
    );
    await expect(window.__brainstrikeWebE2ETestHooks__?.readModelEnabled('model-2')).resolves.toBe(
      false
    );
    await expect(window.__brainstrikeWebE2ETestHooks__?.readModelEnabled('model-3')).resolves.toBe(
      null
    );
    await expect(
      window.__brainstrikeWebE2ETestHooks__?.qualifyDatabaseExtensions()
    ).resolves.toEqual({
      bm25Score: 0.5,
      extensions: ['pg_textsearch', 'pg_trgm', 'vector'],
      fullTextMatch: true,
      vectorDistance: 0,
    });
    await expect(window.__brainstrikeWebE2ETestHooks__?.qualifyLocalEmbedding()).resolves.toEqual({
      device: 'wasm',
      dimensions: 384,
      dtype: 'q4',
      fallbackApplied: false,
      finite: true,
    });
    const runModelSwitchProbe =
      window.__brainstrikeWebE2ETestHooks__?.runEmbeddingModelSwitchMemoryProbe;
    if (!runModelSwitchProbe) {
      throw new Error('Expected the explicitly enabled model-switch probe hook.');
    }
    await expect(runModelSwitchProbe()).resolves.toMatchObject({
      firstGpuEvictedModel: 'gpu-a',
      firstWasmEvictedModel: 'wasm-b',
    });
    await window.__brainstrikeWebE2ETestHooks__?.syncDatabase();

    expect(query).toHaveBeenCalledWith(
      'SELECT id, "resourceId", title, metadata FROM mastra_threads ORDER BY "updatedAt" DESC, id DESC'
    );
    expect(query).toHaveBeenCalledWith('SELECT is_enabled FROM models WHERE id = $1', ['model-1']);
    expect(query).toHaveBeenCalledWith(
      "SELECT extname FROM pg_extension WHERE extname IN ('pg_textsearch', 'pg_trgm', 'vector') ORDER BY extname"
    );
    expect(query).toHaveBeenCalledWith(
      "SELECT ('[1,0,0]'::vector(3) <=> '[1,0,0]'::vector(3))::float8 AS distance, to_tsvector('english', 'brainstrike csp qualification') @@ plainto_tsquery('english', 'brainstrike') AS full_text_match"
    );
    expect(query).toHaveBeenCalledWith(
      "INSERT INTO file_records (id, name, path, size) VALUES ($1, 'csp-qualification.txt', $2, 29)",
      [expect.any(String), expect.stringMatching(/^csp-qualification:\/\//)]
    );
    expect(query).toHaveBeenCalledWith(
      "INSERT INTO file_chunks (id, file_record_id, chunk_index, content) VALUES ($1, $2, 0, 'brainstrike csp qualification')",
      [expect.any(String), expect.any(String)]
    );
    expect(query).toHaveBeenCalledWith(
      "SELECT -(content <@> to_bm25query('brainstrike', 'idx_file_chunks_content_bm25'))::float8 AS bm25_score FROM file_chunks WHERE id = $1",
      [expect.any(String)]
    );
    expect(query).toHaveBeenCalledWith('DELETE FROM file_chunks WHERE id = $1', [
      expect.any(String),
    ]);
    expect(query).toHaveBeenCalledWith('DELETE FROM file_records WHERE id = $1', [
      expect.any(String),
    ]);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith({
      deviceHint: 'wasm',
      dtype: 'q4',
      id: expect.stringMatching(/^csp-embedding-/),
      kind: 'embed',
      maxBatchSize: 1,
      model: 'Xenova/all-MiniLM-L6-v2',
      targetDimension: 384,
      texts: ['Brainstrike production CSP qualification'],
      truncateDim: 384,
    });
    expect(runEmbeddingModelSwitchMemoryProbeMock).toHaveBeenCalledTimes(1);
    expect(syncToFs).toHaveBeenCalledTimes(1);

    unmount();

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeUndefined();
    });
  });

  it('creates and terminally updates assistant runs through strict webdriver-only SQL', async () => {
    setWebDriver(true);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'run-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'run-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    usePGliteDatabaseMock.mockReturnValue({ query } satisfies TestDbHandle);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeDefined();
    });
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected webdriver hooks to be installed');
    }

    await hooks.createAssistantThreadRun({
      id: 'run-1',
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });
    await hooks.completeAssistantThreadRun('run-1', 'completed');

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO brainstrike_assistant_thread_runs'),
      ['run-1', 'workspace-a', 'thread-1', expect.any(Date)]
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE id = $1 AND status = 'running'"),
      ['run-1', 'completed', expect.any(Date)]
    );
    await expect(
      hooks.createAssistantThreadRun({
        id: 'run-missing',
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      })
    ).rejects.toThrow('Web E2E assistant run creation returned no row: run-missing');
  });

  it('reads the run statuses of one thread in creation order through parameterized SQL', async () => {
    setWebDriver(true);
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ status: 'completed' }, { status: 'cancelled' }],
    });
    usePGliteDatabaseMock.mockReturnValue({ query } satisfies TestDbHandle);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeDefined();
    });
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected webdriver hooks to be installed');
    }

    await expect(hooks.readAssistantThreadRunStatuses('thread-1')).resolves.toEqual([
      'completed',
      'cancelled',
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toMatch(
      /SELECT status FROM brainstrike_assistant_thread_runs\s+WHERE thread_id = \$1\s+ORDER BY created_at/
    );
    expect(params).toEqual(['thread-1']);
  });

  it('fails loudly when webdriver tests require sync but the DB handle cannot provide it', async () => {
    setWebDriver(true);
    usePGliteDatabaseMock.mockReturnValue({
      query: vi.fn(),
    } satisfies TestDbHandle);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeDefined();
    });

    await expect(window.__brainstrikeWebE2ETestHooks__?.syncDatabase()).rejects.toThrow(
      'Web E2E database handle does not expose syncToFs'
    );
  });

  it('exposes reset seed, link, and count helpers with observable SQL contracts', async () => {
    setWebDriver(true);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ count: 4 }] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })
      .mockResolvedValueOnce({ rows: [{ count: 6 }] });
    const transactionQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'updated-row' }] });
    const transaction = vi.fn(
      async (callback: (tx: TestDbHandle) => Promise<unknown>): Promise<unknown> =>
        callback({ query: transactionQuery })
    );
    const exec = vi.fn().mockResolvedValue(undefined);
    usePGliteDatabaseMock.mockReturnValue({
      exec,
      query,
      transaction,
    } satisfies TestDbHandle);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeDefined();
    });
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected webdriver hooks to be installed');
    }

    await expect(hooks.readFileRowCounts()).resolves.toEqual({
      fileChunks: 2,
      fileRecords: 3,
    });
    await expect(hooks.readResetRowCounts()).resolves.toEqual({
      fileChunks: 4,
      fileRecords: 5,
      workflowSnapshots: 6,
    });
    await hooks.linkResetProbeRowsToCollection('collection-1');
    await hooks.seedFileRowsOnly();
    await hooks.seedResetProbeRows();

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'SELECT COUNT(*)::int AS count FROM file_chunks',
      'SELECT COUNT(*)::int AS count FROM file_records',
      'SELECT COUNT(*)::int AS count FROM file_chunks',
      'SELECT COUNT(*)::int AS count FROM file_records',
      'SELECT COUNT(*)::int AS count FROM mastra_workflow_snapshot',
    ]);
    expect(transactionQuery).toHaveBeenCalledWith(
      "UPDATE file_records SET embedding_set_id = $1 WHERE path LIKE 'reset-probe://%' RETURNING id",
      ['collection-1']
    );
    expect(transactionQuery).toHaveBeenCalledWith(
      "UPDATE file_chunks SET embedding_set_id = $1 WHERE content = 'reset probe chunk' RETURNING id",
      ['collection-1']
    );
    expect(transactionQuery).toHaveBeenCalledWith(
      'INSERT INTO file_records (id, name, path, size) VALUES ($1, $2, $3, $4)',
      [expect.any(String), 'reset-probe.txt', expect.stringMatching(/^reset-probe:\/\//), 42]
    );
    expect(transactionQuery).toHaveBeenCalledWith(
      'INSERT INTO file_chunks (id, file_record_id, chunk_index, content) VALUES ($1, $2, 0, $3)',
      [expect.any(String), expect.any(String), 'reset probe chunk']
    );
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mastra_workflow_snapshot'),
      ['reset-probe-workflow', expect.any(String), 'reset-probe-resource', '{"status":"suspended"}']
    );
    expect(
      transactionQuery.mock.calls.filter(([sql]) =>
        String(sql).includes('mastra_workflow_snapshot')
      )
    ).toHaveLength(1);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('mastra_workflow_snapshot'));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('fails loudly when reset helpers cannot prove their database effects', async () => {
    setWebDriver(true);
    const transactionQuery = vi.fn().mockResolvedValue({ rows: [] });
    usePGliteDatabaseMock.mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [{ count: 'not-a-number' }] }),
      transaction: vi.fn(async (callback: (tx: TestDbHandle) => Promise<unknown>) =>
        callback({ query: transactionQuery })
      ),
    } satisfies TestDbHandle);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeDefined();
    });
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected webdriver hooks to be installed');
    }

    await expect(hooks.readFileRowCounts()).rejects.toThrow(
      'Count for file_chunks was not numeric'
    );
    await expect(hooks.linkResetProbeRowsToCollection('collection-1')).rejects.toThrow(
      'UPDATE file_records matched zero rows'
    );
    await expect(hooks.seedResetProbeRows()).rejects.toThrow(
      'Web E2E database handle does not expose exec'
    );
  });

  it('fails loudly when reset helpers require unavailable transactions', async () => {
    setWebDriver(true);
    usePGliteDatabaseMock.mockReturnValue({
      exec: vi.fn(),
      query: vi.fn(),
    } satisfies TestDbHandle);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeDefined();
    });
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected webdriver hooks to be installed');
    }

    await expect(hooks.linkResetProbeRowsToCollection('collection-1')).rejects.toThrow(
      'Web E2E database handle does not expose transactions'
    );
    await expect(hooks.seedFileRowsOnly()).rejects.toThrow(
      'Web E2E database handle does not expose transactions'
    );
    await expect(hooks.seedResetProbeRows()).rejects.toThrow(
      'Web E2E database handle does not expose transactions'
    );
  });
});
