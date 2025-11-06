import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanel } from '../right-panel';
import { __resetDbPanelStoreForTests, useDbPanelStore } from '../stores/db-panel-store';
import {
  __resetRightPanelStoreForTests,
  // keep import named to satisfy tree-shaking and explicitness
  useRightPanelStore,
} from '../stores/right-panel-store';
import { __resetSearchPanelStoreForTests, useSearchPanelStore } from '../stores/search-panel-store';

vi.mock('@brainstrike/db', () => ({
  useFileRecordRepository: () => null,
  usePGliteDatabase: () => null,
  useFileChunkRepository: () => null,
  useClearAllData: () => null,
  useDbProviderError: () => null,
  useVectorEnabled: () => false,
  useFactoryReset: () => null,
}));

vi.mock('@brainstrike/embeddings', async () => {
  const actual = await vi.importActual<object>('@brainstrike/embeddings');
  return {
    ...(actual as object),
    TransformersBackend: { getBestDevice: () => 'cpu' },
  };
});

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual('@brainstrike/ui');
  return {
    ...actual,
    useToast: () => ({ toast: vi.fn() }),
  };
});

vi.mock('@brainstrike/db-explorer', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db-explorer')>(
    '@brainstrike/db-explorer'
  );
  return {
    ...actual,
    DatabaseDemoPanel: () => <div data-testid="mock-database-panel">DatabasePanel</div>,
    EmbeddingsPanel: () => (
      <div data-testid="mock-embeddings-panel">
        <div>Text Embeddings</div>
        <div>Generate embeddings and calculate text similarity</div>
      </div>
    ),
  };
});

vi.mock('@brainstrike/vector-management', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/vector-management')>(
    '@brainstrike/vector-management'
  );
  return {
    ...actual,
    VectorStatusWithDialog: () => <div data-testid="mock-vector-status">VectorStatus</div>,
    QueueHud: () => <div data-testid="mock-queue-hud">QueueHud</div>,
  };
});

vi.mock('../file-import-service', () => ({
  useFileImportService: () => ({ isImporting: false, progress: null }),
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({ fileSystemAdapter: null, databaseAdapter: null }),
}));

vi.mock('@brainstrike/file-explorer-ui', () => ({
  useFileExplorer: () => ({ fileContents: {}, fileTree: [] }),
  useSelectionManager: () => ({ selectedFilePaths: new Set() }),
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('RightPanel controls', () => {
  const originalFetch = global.fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    // Reset persisted UI stores to avoid cross-test flakiness
    __resetRightPanelStoreForTests();
    __resetSearchPanelStoreForTests();
    __resetDbPanelStoreForTests();

    // Make assistant status check fast and deterministic
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: false, reason: 'no_providers_configured', providers: [] }),
    } as Response);
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    mockFetch.mockReset();
    global.fetch = originalFetch;
  });

  it('updates search filters', async () => {
    render(<RightPanel />);

    // Switch to Search tab via store to avoid pointer-event flakiness
    act(() => {
      useRightPanelStore.getState().setActiveTab('search');
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /search/i })).toHaveAttribute('aria-selected', 'true');
    });

    // Update search controls using fireEvent for speed
    const query = screen.getByLabelText('Query');
    fireEvent.change(query, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByLabelText('Regex'));
    fireEvent.click(screen.getByLabelText('Case'));
    fireEvent.click(screen.getByLabelText('Whole word'));

    // Verify search state
    await waitFor(() => {
      const searchState = useSearchPanelStore.getState();
      expect(searchState.query).toBe('hello world');
      expect(searchState.regex).toBe(true);
      expect(searchState.caseSensitive).toBe(true);
      expect(searchState.wholeWord).toBe(true);
    });
  }, 10000);

  it('updates database logs controls', async () => {
    render(<RightPanel />);

    // Switch to Database tab via store
    act(() => {
      useRightPanelStore.getState().setActiveTab('database');
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /db/i })).toHaveAttribute('aria-selected', 'true');
    });

    // Select logs subtab
    const viewRow = screen.getByText('View').closest('div');
    const select = within(viewRow as HTMLElement).getByRole('combobox', { name: 'DB subtab' });
    fireEvent.change(select, { target: { value: 'logs' } });

    // Update DB controls using fireEvent for speed
    await waitFor(() => {
      expect(screen.getByLabelText('Filter')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'embeddings' } });
    fireEvent.change(screen.getByLabelText('Sort By'), { target: { value: 'timestamp' } });
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'desc' } });
    fireEvent.change(screen.getByLabelText('Page'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Page Size'), { target: { value: '25' } });

    // Verify DB state
    await waitFor(() => {
      const dbState = useDbPanelStore.getState();
      expect(dbState.activeSubtab).toBe('logs');
      expect(dbState.filterText).toBe('embeddings');
      expect(dbState.sortBy).toBe('timestamp');
      expect(dbState.sortDir).toBe('desc');
      expect(dbState.page).toBeGreaterThan(1);
      expect(dbState.pageSize).toBeGreaterThan(10);
    });
  }, 10000);
});
