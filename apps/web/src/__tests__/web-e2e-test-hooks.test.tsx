import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebE2ETestHooks } from '../web-e2e-test-hooks';

const usePGliteDatabaseMock = vi.hoisted(() => vi.fn());
const useBrainstrikeExecutionDbClientMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: usePGliteDatabaseMock,
  useBrainstrikeExecutionDbClient: useBrainstrikeExecutionDbClientMock,
}));

interface TestDbHandle {
  readonly query: ReturnType<typeof vi.fn>;
  readonly syncToFs?: ReturnType<typeof vi.fn>;
}

interface TestExecutionClient {
  readonly db: { readonly query: ReturnType<typeof vi.fn> };
  readonly runtimeEngine: 'turso';
  readonly sqlCapabilities: { readonly dialect: 'sqlite' };
}

function createTursoExecutionClient(query: ReturnType<typeof vi.fn>): TestExecutionClient {
  return {
    db: { query },
    runtimeEngine: 'turso',
    sqlCapabilities: { dialect: 'sqlite' },
  };
}

function setWebDriver(value: boolean): void {
  vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(value);
}

describe('WebE2ETestHooks', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, '__brainstrikeWebE2ETestHooks__');
    usePGliteDatabaseMock.mockReset();
    useBrainstrikeExecutionDbClientMock.mockReset();
    useBrainstrikeExecutionDbClientMock.mockReturnValue(null);
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
            resourceId: 'workspace-a',
            title: 'Debug reload',
            metadata: { icon: 'bug', color: 'rose' },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ is_enabled: 'true' }] })
      .mockResolvedValueOnce({ rows: [{ is_enabled: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const syncToFs = vi.fn().mockResolvedValue(undefined);
    usePGliteDatabaseMock.mockReturnValue({
      query,
      syncToFs,
    } satisfies TestDbHandle);

    const { unmount } = render(<WebE2ETestHooks dbPath="idb://web-e2e-test" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__?.dbPath).toBe('idb://web-e2e-test');
    });

    await expect(window.__brainstrikeWebE2ETestHooks__?.readAssistantThreads()).resolves.toEqual([
      {
        id: 'thread-1',
        resourceId: 'workspace-a',
        title: 'Debug reload',
        metadata: { icon: 'bug', color: 'rose' },
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
    await window.__brainstrikeWebE2ETestHooks__?.syncDatabase();

    expect(query).toHaveBeenCalledWith(
      'SELECT id, "resourceId", title, metadata FROM mastra_threads ORDER BY "updatedAt" DESC, id DESC'
    );
    expect(query).toHaveBeenCalledWith('SELECT is_enabled FROM models WHERE id = $1', ['model-1']);
    expect(syncToFs).toHaveBeenCalledTimes(1);

    unmount();

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeUndefined();
    });
  });

  it('exposes hooks over the browser Turso execution client with SQLite placeholders (A7 cutover)', async () => {
    setWebDriver(true);
    usePGliteDatabaseMock.mockReturnValue(null);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ is_enabled: 1 }] })
      .mockResolvedValueOnce({ rows: [{ is_enabled: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    useBrainstrikeExecutionDbClientMock.mockReturnValue(createTursoExecutionClient(query));

    const { unmount } = render(<WebE2ETestHooks dbPath="web-e2e-turso-test.db" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__?.dbPath).toBe('web-e2e-turso-test.db');
    });

    await expect(window.__brainstrikeWebE2ETestHooks__?.readModelEnabled('model-1')).resolves.toBe(
      true
    );
    await expect(window.__brainstrikeWebE2ETestHooks__?.readModelEnabled('model-2')).resolves.toBe(
      false
    );
    await expect(window.__brainstrikeWebE2ETestHooks__?.readModelEnabled('model-3')).resolves.toBe(
      null
    );
    expect(query).toHaveBeenCalledWith('SELECT is_enabled FROM models WHERE id = ?', ['model-1']);

    // Browser Turso WAL commits are durable in OPFS without an explicit
    // flush, so syncDatabase resolves without a driver call.
    await expect(window.__brainstrikeWebE2ETestHooks__?.syncDatabase()).resolves.toBeUndefined();

    unmount();

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeUndefined();
    });
  });

  it('propagates browser Turso thread-read failures instead of masking them', async () => {
    setWebDriver(true);
    usePGliteDatabaseMock.mockReturnValue(null);
    const query = vi.fn().mockRejectedValue(new Error('no such table: mastra_threads'));
    useBrainstrikeExecutionDbClientMock.mockReturnValue(createTursoExecutionClient(query));

    render(<WebE2ETestHooks dbPath="web-e2e-turso-test.db" />);

    await waitFor(() => {
      expect(window.__brainstrikeWebE2ETestHooks__).toBeDefined();
    });

    await expect(window.__brainstrikeWebE2ETestHooks__?.readAssistantThreads()).rejects.toThrow(
      'no such table: mastra_threads'
    );
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
