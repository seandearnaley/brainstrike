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
