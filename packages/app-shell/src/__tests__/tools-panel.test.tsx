import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ToolsPanel } from '../tools-panel';

const originalFetch = global.fetch;
const mockFetch = vi.fn();
const { mockPreloadAssistantUiPanelWrapper, mockPreloadDatabaseTab } = vi.hoisted(() => ({
  mockPreloadAssistantUiPanelWrapper: vi.fn(() => Promise.resolve()),
  mockPreloadDatabaseTab: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ enabled: false, reason: 'no_providers_configured', providers: [] }),
  } as Response);
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  mockFetch.mockReset();
  mockPreloadAssistantUiPanelWrapper.mockClear();
  mockPreloadDatabaseTab.mockClear();
  global.fetch = originalFetch;
});

// Mock the database dependencies
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useClearAllData: () => null,
  useDbProviderError: () => null,
  useFactoryReset: () => null,
  useFileChunkRepository: () => null,
  useFileRecordRepository: () => null, // Return null to simulate loading state
  usePGliteDatabase: () => null,
  useVectorEnabled: () => false,
}));

// Mock embeddings device helper to avoid module resolution issues in tests
vi.mock('@brainstrike/embeddings', async () => {
  const actual = await vi.importActual<object>('@brainstrike/embeddings');
  return {
    ...(actual as object),
    TransformersBackend: { getBestDevice: () => 'cpu' },
  };
});

// Mock the UI toast functionality
vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual('@brainstrike/ui');
  return {
    ...actual,
    useToast: () => ({
      toast: vi.fn(),
    }),
  };
});

// Mock the file import service
vi.mock('../file-import-service', () => ({
  useFileImportService: () => ({
    isImporting: false,
    progress: null,
  }),
}));

// Mock the file explorer hooks
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    fileSystemAdapter: null,
    databaseAdapter: null,
  }),
}));

// Mock the file explorer UI hooks
vi.mock('@brainstrike/file-explorer-ui', () => ({
  useFileExplorer: () => ({
    fileContents: {},
    fileTree: [],
  }),
  useSelectionManager: () => ({
    selectedFilePaths: new Set(),
  }),
}));

// Mock the lazy-loaded tabs to avoid loading real dashboards in tests
// Note: We mock the wrapper component (database-tab) not the chunk files,
// since tools-panel.tsx imports from the wrapper which uses React.lazy internally.
vi.mock('../database-tab', () => ({
  DatabaseTab: () => <div data-testid="mock-database-panel">Database mock</div>,
  preloadDatabaseTab: mockPreloadDatabaseTab,
}));

vi.mock('../assistant-ui-panel-wrapper-lazy', () => ({
  AssistantUiPanelWrapperLazy: () => <div>Assistant UI Panel</div>,
  preloadAssistantUiPanelWrapper: mockPreloadAssistantUiPanelWrapper,
}));

describe('ToolsPanel', () => {
  test('renders with assistant and database tabs', async () => {
    render(<ToolsPanel />);

    // Check that all tab triggers are present
    expect(screen.getByRole('tab', { name: /assistant/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /database/i })).toBeInTheDocument();

    // Wait for async state updates to complete
    await screen.findByTestId('assistant-chat-card');
  });

  test('shows assistant tab content by default', async () => {
    render(<ToolsPanel />);

    // Assistant tab should be active by default - wait for async updates
    const assistantCard = await screen.findByTestId('assistant-chat-card');
    expect(assistantCard).toBeInTheDocument();
    expect(screen.getByText(/Chat with the Brainstrike assistant/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(mockPreloadAssistantUiPanelWrapper).toHaveBeenCalledTimes(1);
    });
  });

  test('preloads the database tab chunk on idle after mount', async () => {
    render(<ToolsPanel preloadDatabaseTabOnMount />);

    await screen.findByTestId('assistant-chat-card');

    await waitFor(() => {
      expect(mockPreloadDatabaseTab).toHaveBeenCalledTimes(1);
    });
  });

  test('allows switching between tabs', async () => {
    const user = userEvent.setup();
    render(<ToolsPanel />);

    await screen.findByTestId('assistant-chat-card');

    // Click on the database tab
    await user.click(screen.getByRole('tab', { name: /database/i }));
    const dbPanel = await screen.findByRole('tabpanel', { name: /database/i });
    expect(dbPanel).toBeInTheDocument();
    expect(await within(dbPanel).findByTestId('mock-database-panel')).toBeInTheDocument();

    // Assistant tab should render status callout
    await user.click(screen.getByRole('tab', { name: /assistant/i }));
    const assistantPanel = await screen.findByRole('tabpanel', { name: /assistant/i });
    expect(assistantPanel).toBeInTheDocument();
    expect(await within(assistantPanel).findByText(/Assistant disabled/i)).toBeInTheDocument();
  }, 30_000);

  test('has proper tab structure with icons', async () => {
    render(<ToolsPanel />);

    // Wait for async state updates
    await screen.findByTestId('assistant-chat-card');

    // Check that tabs have icons (we can't easily test the actual icons, but we can check the structure)
    const tabList = screen.getByRole('tablist');
    expect(tabList).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);

    // Each tab should have text content
    expect(tabs[0]).toHaveTextContent('Assistant');
    expect(tabs[1]).toHaveTextContent('DB');
  });

  test('maintains content state when switching tabs', async () => {
    const user = userEvent.setup();
    render(<ToolsPanel />);

    await screen.findByTestId('assistant-chat-card');

    await user.click(screen.getByRole('tab', { name: /assistant/i }));
    expect(await screen.findByText(/Assistant disabled/i)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /database/i }));
    const dbPanel = await screen.findByRole('tabpanel', { name: /database/i });
    expect(await within(dbPanel).findByTestId('mock-database-panel')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /assistant/i }));
    expect(await screen.findByText(/Chat with the Brainstrike assistant/i)).toBeInTheDocument();
  }, 30_000);
});
