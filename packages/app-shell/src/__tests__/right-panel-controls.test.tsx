import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanel } from '../right-panel';
import { __resetDbPanelStoreForTests, useDbPanelStore } from '../stores/db-panel-store';
import {
  __resetRightPanelStoreForTests,
  // keep import named to satisfy tree-shaking and explicitness
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

  it('updates search filters and DB logs controls', async () => {
    const user = userEvent.setup();
    render(<RightPanel />);

    // Switch to Search tab and wait for it to be selected
    await user.click(screen.getByRole('tab', { name: /search/i }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /search/i })).toHaveAttribute('aria-selected', 'true');
    });

    // Update search controls
    const query = screen.getByLabelText('Query');
    await user.clear(query);
    await user.type(query, 'hello world');
    await user.click(screen.getByLabelText('Regex'));
    await user.click(screen.getByLabelText('Case'));
    await user.click(screen.getByLabelText('Whole word'));

    // Verify search state
    const searchState = useSearchPanelStore.getState();
    expect(searchState.query).toBe('hello world');
    expect(searchState.regex).toBe(true);
    expect(searchState.caseSensitive).toBe(true);
    expect(searchState.wholeWord).toBe(true);

    // Switch to Database tab and wait for it to be selected
    await user.click(screen.getByRole('tab', { name: /db/i }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /db/i })).toHaveAttribute('aria-selected', 'true');
    });

    // Select logs subtab
    const viewRow = screen.getByText('View').closest('div');
    const select = within(viewRow as HTMLElement).getByRole('combobox', { name: 'DB subtab' });
    await user.selectOptions(select, 'logs');

    // Update DB controls
    await user.type(screen.getByLabelText('Filter'), 'embeddings');
    const sortBy = screen.getByLabelText('Sort By');
    await user.clear(sortBy);
    await user.type(sortBy, 'timestamp');
    await user.selectOptions(screen.getByLabelText('Direction'), 'desc');
    const page = screen.getByLabelText('Page');
    await user.clear(page);
    await user.type(page, '2');
    const pageSize = screen.getByLabelText('Page Size');
    await user.clear(pageSize);
    await user.type(pageSize, '25');

    // Verify DB state
    const dbState = useDbPanelStore.getState();
    expect(dbState.activeSubtab).toBe('logs');
    expect(dbState.filterText).toBe('embeddings');
    expect(dbState.sortBy).toBe('timestamp');
    expect(dbState.sortDir).toBe('desc');
    expect(dbState.page).toBeGreaterThan(1);
    expect(dbState.pageSize).toBeGreaterThan(10);
  });
});
