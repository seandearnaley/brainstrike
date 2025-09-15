import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { RightPanel } from '../right-panel';

// Mock the database dependencies
vi.mock('@brainstrike/db', () => ({
  useFileRecordRepository: () => null, // Return null to simulate loading state
  usePGliteDatabase: () => null,
  useFileChunkRepository: () => null,
  useClearAllData: () => null,
  useDbProviderError: () => null,
  useVectorEnabled: () => false,
  useFactoryReset: () => null,
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

describe('RightPanel', () => {
  test('renders with all tabs', () => {
    render(<RightPanel />);

    // Check that all tab triggers are present
    expect(screen.getByRole('tab', { name: /props/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /embed/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /search/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /db/i })).toBeInTheDocument();
  });

  test('shows properties tab content by default', () => {
    render(<RightPanel />);

    // Properties tab should be active by default
    expect(screen.getByText('Properties')).toBeInTheDocument();
    expect(screen.getByText('Element properties and attributes')).toBeInTheDocument();
    expect(screen.getByText('Basic Properties')).toBeInTheDocument();
  });

  test('allows switching between tabs', async () => {
    const user = userEvent.setup();
    render(<RightPanel />);

    // Click on the embeddings tab
    await user.click(screen.getByRole('tab', { name: /embed/i }));

    // Should show embeddings content
    expect(screen.getByText('Text Embeddings')).toBeInTheDocument();
    expect(
      screen.getByText('Generate embeddings and calculate text similarity')
    ).toBeInTheDocument();

    // Click on the search tab
    await user.click(screen.getByRole('tab', { name: /search/i }));

    // Should show search content
    expect(screen.getByText('Search and replace functionality')).toBeInTheDocument();
    expect(screen.getByText('Search Options')).toBeInTheDocument();

    // Click on the database tab
    await user.click(screen.getByRole('tab', { name: /db/i }));

    // Should show database content; allow either initializing or disabled message depending on build flag
    const dbPanel = screen.getByRole('tabpanel', { name: /db/i });
    expect(dbPanel).toBeInTheDocument();
    expect(
      within(dbPanel).getByText(/Database (is initializing|UI disabled)/i)
    ).toBeInTheDocument();
  });

  test('has proper tab structure with icons', () => {
    render(<RightPanel />);

    // Check that tabs have icons (we can't easily test the actual icons, but we can check the structure)
    const tabList = screen.getByRole('tablist');
    expect(tabList).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);

    // Each tab should have text content
    expect(tabs[0]).toHaveTextContent('Props');
    expect(tabs[1]).toHaveTextContent('Embed');
    expect(tabs[2]).toHaveTextContent('Search');
    expect(tabs[3]).toHaveTextContent('DB');
  });

  test('maintains content state when switching tabs', async () => {
    const user = userEvent.setup();
    render(<RightPanel />);

    // Switch to embeddings tab
    await user.click(screen.getByRole('tab', { name: /embed/i }));
    expect(screen.getByText('Text Embeddings')).toBeInTheDocument();

    // Switch back to properties tab
    await user.click(screen.getByRole('tab', { name: /props/i }));
    expect(screen.getByText('Basic Properties')).toBeInTheDocument();

    // Switch to embeddings again - content should still be there
    await user.click(screen.getByRole('tab', { name: /embed/i }));
    expect(screen.getByText('Text Embeddings')).toBeInTheDocument();
  });
});
