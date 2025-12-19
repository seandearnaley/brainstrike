import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RightPanel } from '../right-panel';

const originalFetch = global.fetch;
const mockFetch = vi.fn();

beforeEach(() => {
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

vi.mock('@brainstrike/db-explorer', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/db-explorer')>(
    '@brainstrike/db-explorer'
  );
  return {
    ...actual,
    DatabaseDemoPanel: () => <div data-testid="mock-database-panel">DatabasePanel</div>,
    EmbeddingsPanel: () => (
      <div data-testid="mock-embeddings-panel">
        <div>Embedding Playground</div>
        <div>Test individual models and similarity (not tied to your vector DB)</div>
      </div>
    ),
  };
});

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

// Mock the heavy database chunk to avoid loading real vector dashboards in tests
vi.mock('../database-tab-chunk', () => ({
  DatabaseTab: () => <div data-testid="mock-database-panel">Database mock</div>,
}));

// Mock the vectors tab chunk to avoid loading real vector dashboards in tests
vi.mock('../vectors-tab-chunk', () => ({
  VectorsTab: () => <div data-testid="mock-vectors-panel">Vectors mock</div>,
}));

describe('RightPanel', () => {
  test('renders with all tabs', async () => {
    render(<RightPanel />);

    // Check that all tab triggers are present
    expect(screen.getByRole('tab', { name: /assistant/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /embed/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /vectors/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /db/i })).toBeInTheDocument();

    // Wait for async state updates to complete
    await screen.findByTestId('assistant-chat-card');
  });

  test('shows assistant tab content by default', async () => {
    render(<RightPanel />);

    // Assistant tab should be active by default - wait for async updates
    const assistantCard = await screen.findByTestId('assistant-chat-card');
    expect(assistantCard).toBeInTheDocument();
    expect(screen.getByText(/Chat with the Brainstrike assistant/i)).toBeInTheDocument();
  });

  test('allows switching between tabs', async () => {
    const user = userEvent.setup();
    render(<RightPanel />);

    await screen.findByTestId('assistant-chat-card');

    // Click on the embeddings tab
    await user.click(screen.getByRole('tab', { name: /embed/i }));

    expect(await screen.findByText('Embedding Playground')).toBeInTheDocument();
    expect(
      await screen.findByText('Test individual models and similarity (not tied to your vector DB)')
    ).toBeInTheDocument();

    // Click on the vectors tab
    await user.click(screen.getByRole('tab', { name: /vectors/i }));
    const vectorsPanel = await screen.findByRole('tabpanel', { name: /vectors/i });
    expect(vectorsPanel).toBeInTheDocument();
    expect(await within(vectorsPanel).findByTestId('mock-vectors-panel')).toBeInTheDocument();

    // Click on the database tab
    await user.click(screen.getByRole('tab', { name: /db/i }));
    const dbPanel = await screen.findByRole('tabpanel', { name: /db/i });
    expect(dbPanel).toBeInTheDocument();
    expect(await within(dbPanel).findByTestId('mock-database-panel')).toBeInTheDocument();

    // Assistant tab should render status callout
    await user.click(screen.getByRole('tab', { name: /assistant/i }));
    const assistantPanel = await screen.findByRole('tabpanel', { name: /assistant/i });
    expect(assistantPanel).toBeInTheDocument();
    expect(await within(assistantPanel).findByText(/Assistant disabled/i)).toBeInTheDocument();
  }, 30_000);

  test('has proper tab structure with icons', async () => {
    render(<RightPanel />);

    // Wait for async state updates
    await screen.findByTestId('assistant-chat-card');

    // Check that tabs have icons (we can't easily test the actual icons, but we can check the structure)
    const tabList = screen.getByRole('tablist');
    expect(tabList).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);

    // Each tab should have text content
    expect(tabs[0]).toHaveTextContent('Assistant');
    expect(tabs[1]).toHaveTextContent('Embed');
    expect(tabs[2]).toHaveTextContent('Vectors');
    expect(tabs[3]).toHaveTextContent('DB');
  });

  test('maintains content state when switching tabs', async () => {
    const user = userEvent.setup();
    render(<RightPanel />);

    await screen.findByTestId('assistant-chat-card');

    await user.click(screen.getByRole('tab', { name: /embed/i }));
    expect(await screen.findByText('Embedding Playground')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /assistant/i }));
    expect(await screen.findByText(/Assistant disabled/i)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /embed/i }));
    expect(await screen.findByText('Embedding Playground')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /vectors/i }));
    const vectorsPanel = await screen.findByRole('tabpanel', { name: /vectors/i });
    expect(await within(vectorsPanel).findByTestId('mock-vectors-panel')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /db/i }));
    const dbPanel = await screen.findByRole('tabpanel', { name: /db/i });
    expect(await within(dbPanel).findByTestId('mock-database-panel')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /assistant/i }));
    expect(await screen.findByText(/Chat with the Brainstrike assistant/i)).toBeInTheDocument();
  }, 30_000);
});
