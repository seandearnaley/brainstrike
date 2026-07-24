import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebE2ETestHooks } from '../web-e2e-test-hooks';

const usePGliteDatabaseMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: usePGliteDatabaseMock,
}));

interface TestDbHandle {
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
    usePGliteDatabaseMock.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__brainstrikeWebE2ETestHooks__');
    vi.restoreAllMocks();
  });

  it('does not expose hooks outside webdriver automation', async () => {
    setWebDriver(false);
    window.__brainstrikeWebE2ETestHooks__ = {
      dbPath: 'idb://old',
      qualifyDatabaseExtensions: vi.fn(),
      readAssistantThreads: vi.fn(),
      readModelEnabled: vi.fn(),
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
      dbPath: 'idb://old',
      qualifyDatabaseExtensions: vi.fn(),
      readAssistantThreads: vi.fn(),
      readModelEnabled: vi.fn(),
      syncDatabase: vi.fn(),
    };
    usePGliteDatabaseMock.mockReturnValue(null);

    render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeUndefined();
    });
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
    expect(syncToFs).toHaveBeenCalledTimes(1);

    unmount();

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeUndefined();
    });
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
});
