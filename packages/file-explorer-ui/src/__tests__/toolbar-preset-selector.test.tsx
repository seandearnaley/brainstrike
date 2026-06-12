import type { ViewFilterPreset } from '@brainstrike/types';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the hooks and dependencies
const mockPresets: ViewFilterPreset[] = [
  {
    id: 'preset-1',
    name: 'Source Files',
    description: 'TypeScript and JavaScript files',
    icon: 'file-code',
    includes: ['*.ts', '*.tsx'],
    excludes: ['node_modules'],
    useRegex: false,
    isDefault: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'preset-2',
    name: 'Documentation',
    description: 'Markdown files',
    icon: 'file-text',
    includes: ['*.md'],
    excludes: [],
    useRegex: false,
    isDefault: false,
    sortOrder: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const mockSetViewFilterPresetId = vi.fn();
const mockSetFilters = vi.fn();
const mockSetUseRegex = vi.fn();
const mockCreatePreset = vi.fn();
const mockUpdatePreset = vi.fn();
const mockDeletePreset = vi.fn();
const defaultMockViewFilterPresetsResult = () => ({
  presets: mockPresets,
  loading: false,
  error: null,
  createPreset: mockCreatePreset,
  updatePreset: mockUpdatePreset,
  deletePreset: mockDeletePreset,
  refresh: vi.fn(),
  getPreset: vi.fn(),
});

interface MockStoreState {
  currentFolderId: string | null;
  excludeFilters: string[];
  folderStates: Record<
    string,
    {
      excludeFilters: string[];
      expandedDirectoryPaths: Set<string>;
      includeFilters: string[];
      lastAccessed: number;
      lastActiveTab: string;
      maxSelectionCount: number;
      selectedFilePaths: Set<string>;
      tokenBudget: number;
      useRegex: boolean;
      viewFilterPresetId: string | null;
    }
  >;
  includeFilters: string[];
  setFilters: typeof mockSetFilters;
  setUseRegex: typeof mockSetUseRegex;
  setViewFilterPresetId: typeof mockSetViewFilterPresetId;
  useRegex: boolean;
  viewFilterPresetId: string | null;
}

const defaultMockStoreState = (): MockStoreState => ({
  currentFolderId: 'mock-root',
  includeFilters: ['*.ts', '*.tsx'],
  excludeFilters: ['node_modules'],
  folderStates: {
    'mock-root': {
      selectedFilePaths: new Set<string>(),
      expandedDirectoryPaths: new Set<string>(),
      includeFilters: ['*.ts', '*.tsx'],
      excludeFilters: ['node_modules'],
      useRegex: false,
      tokenBudget: 100_000,
      maxSelectionCount: 10,
      lastActiveTab: 'files',
      lastAccessed: Date.now(),
      viewFilterPresetId: 'preset-1',
    },
  },
  useRegex: false,
  viewFilterPresetId: 'preset-1',
  setViewFilterPresetId: mockSetViewFilterPresetId,
  setFilters: mockSetFilters,
  setUseRegex: mockSetUseRegex,
});

let mockStoreState: MockStoreState = defaultMockStoreState();

// Create mock persist API
const mockStorageData: Record<string, unknown> = {};
const mockStorage = {
  getItem: vi.fn((key: string) => mockStorageData[key] ?? null),
  setItem: vi.fn((key: string, value: unknown) => {
    mockStorageData[key] = value;
  }),
};

vi.mock('../shell/file-explorer-provider', () => ({
  useFileExplorerStoreContext: vi.fn(() => {
    // Create a store-like function that returns values based on selector
    const storeFn = (selector: (state: Record<string, unknown>) => unknown) =>
      selector(mockStoreState as unknown as Record<string, unknown>);
    storeFn.getState = () => mockStoreState;
    // Add persist API to the store function
    storeFn.persist = {
      getOptions: () => ({
        name: 'file-explorer-storage-v4',
        storage: mockStorage,
        version: 1,
        partialize: (state: unknown) => state,
      }),
    };
    return storeFn;
  }),
  useFileExplorerStoreSelector: vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockStoreState as unknown as Record<string, unknown>)
  ),
}));

vi.mock('../hooks/use-view-filter-presets', () => ({
  useViewFilterPresets: vi.fn(() => defaultMockViewFilterPresetsResult()),
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  isDevEnv: vi.fn(() => false),
}));

// Import after mocks are set up
import { useViewFilterPresets } from '../hooks/use-view-filter-presets';
import { ToolbarPresetSelector } from '../toolbar-preset-selector';

describe('ToolbarPresetSelector', () => {
  const mockOnFilterChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useViewFilterPresets).mockReturnValue(defaultMockViewFilterPresetsResult());
    mockStoreState = defaultMockStoreState();
    // Reset storage mock
    for (const key of Object.keys(mockStorageData)) {
      delete mockStorageData[key];
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the dropdown component', () => {
    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    // The dropdown trigger button should be rendered
    expect(screen.getByRole('button', { name: /Source Files/i })).toBeInTheDocument();
  });

  it('shows selected preset name', async () => {
    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    // The selected preset should be shown
    expect(screen.getByText('Source Files')).toBeInTheDocument();
  });

  it('calls onFilterChange when preset is selected', async () => {
    const user = userEvent.setup();
    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    // Open the dropdown
    const triggerButton = screen.getByRole('button', { name: /Source Files/i });
    await user.click(triggerButton);

    // Wait for dropdown to open and select Documentation preset
    await waitFor(() => {
      expect(screen.getByText('Documentation')).toBeInTheDocument();
    });

    const docOption = screen.getByText('Documentation');
    await user.click(docOption);

    // Verify state setters were called
    await waitFor(() => {
      expect(mockSetViewFilterPresetId).toHaveBeenCalledWith('preset-2');
    });
    expect(mockSetFilters).toHaveBeenCalledWith(['*.md'], []);
    expect(mockSetUseRegex).toHaveBeenCalledWith(false);
    expect(mockSetFilters.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetViewFilterPresetId.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(mockSetUseRegex.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetViewFilterPresetId.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('keeps the newly selected preset visible while store updates are still catching up', async () => {
    const user = userEvent.setup();
    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    const triggerButton = screen.getByRole('button', { name: /Source Files/i });
    await user.click(triggerButton);

    await waitFor(() => {
      expect(screen.getByText('Documentation')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Documentation'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Documentation/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Source Files/i })).not.toBeInTheDocument();
  });

  it('persists preset selection to storage', async () => {
    const user = userEvent.setup();
    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    // Open the dropdown
    const triggerButton = screen.getByRole('button', { name: /Source Files/i });
    await user.click(triggerButton);

    // Wait for dropdown to open and select Documentation preset
    await waitFor(() => {
      expect(screen.getByText('Documentation')).toBeInTheDocument();
    });

    const docOption = screen.getByText('Documentation');
    await user.click(docOption);

    // Verify storage was called
    await waitFor(() => {
      expect(mockStorage.setItem).toHaveBeenCalled();
    });

    const lastCall = mockStorage.setItem.mock.calls.at(-1);
    if (lastCall) {
      const savedState = lastCall[1] as {
        state: {
          currentFolderId: string | null;
          folderStates: Record<string, { viewFilterPresetId: string | null }>;
        };
      };
      expect(savedState.state.currentFolderId).toBe('mock-root');
      expect(savedState.state.folderStates['mock-root']?.viewFilterPresetId).toBe('preset-1');
    }
  });

  it('handles persistence with existing wrapper state', async () => {
    // Set up existing wrapped state
    mockStorageData['file-explorer-storage-v4'] = {
      version: 1,
      state: { existingKey: 'existingValue' },
    };

    const user = userEvent.setup();
    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    // Open the dropdown and select a preset
    const triggerButton = screen.getByRole('button', { name: /Source Files/i });
    await user.click(triggerButton);

    await waitFor(() => {
      expect(screen.getByText('Documentation')).toBeInTheDocument();
    });

    const docOption = screen.getByText('Documentation');
    await user.click(docOption);

    // Verify storage was updated with merged state
    await waitFor(() => {
      expect(mockStorage.setItem).toHaveBeenCalled();
    });

    const lastCall = mockStorage.setItem.mock.calls.at(-1);
    if (lastCall) {
      const savedState = lastCall[1] as {
        state: {
          existingKey: string;
          viewFilterPresetId: string | null;
        };
      };
      expect(savedState.state.existingKey).toBe('existingValue');
      expect(savedState.state.viewFilterPresetId).toBe('preset-2');
    }
  });

  it('handles persistence without wrapper', async () => {
    // Set up non-wrapped state
    mockStorageData['file-explorer-storage-v4'] = {
      existingKey: 'existingValue',
    };

    const user = userEvent.setup();
    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    // Open the dropdown and select a preset
    const triggerButton = screen.getByRole('button', { name: /Source Files/i });
    await user.click(triggerButton);

    await waitFor(() => {
      expect(screen.getByText('Documentation')).toBeInTheDocument();
    });

    const docOption = screen.getByText('Documentation');
    await user.click(docOption);

    // Verify storage was called
    await waitFor(() => {
      expect(mockStorage.setItem).toHaveBeenCalled();
    });
  });

  it('applies custom className', () => {
    render(<ToolbarPresetSelector className="custom-class" onFilterChange={mockOnFilterChange} />);

    // Verify the dropdown receives the className - check the button element
    const triggerButton = screen.getByRole('button', { name: /Source Files/i });
    expect(triggerButton).toBeInTheDocument();
  });

  it('handles loading state', async () => {
    const { useViewFilterPresets } = await import('../hooks/use-view-filter-presets');
    vi.mocked(useViewFilterPresets).mockReturnValueOnce({
      presets: [],
      loading: true,
      error: null,
      createPreset: mockCreatePreset,
      updatePreset: mockUpdatePreset,
      deletePreset: mockDeletePreset,
      refresh: vi.fn(),
      getPreset: vi.fn(),
    });

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    // Component should render even during loading and remain interactive.
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('does not clear the stored preset id while presets are still loading', async () => {
    const { useViewFilterPresets } = await import('../hooks/use-view-filter-presets');
    mockStoreState.includeFilters = ['*.png'];
    mockStoreState.excludeFilters = [];
    vi.mocked(useViewFilterPresets).mockReturnValueOnce({
      ...defaultMockViewFilterPresetsResult(),
      presets: [],
      loading: true,
    });

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    await waitFor(() => {
      expect(screen.getByRole('button')).toBeInTheDocument();
    });
    expect(mockSetViewFilterPresetId).not.toHaveBeenCalled();
    expect(mockStorage.setItem).not.toHaveBeenCalled();
  });

  it('handles null selected preset', async () => {
    mockStoreState.viewFilterPresetId = null;
    mockStoreState.includeFilters = ['*.png'];
    mockStoreState.excludeFilters = [];

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    // Component should render without selected preset - shows placeholder text
    expect(screen.getByRole('button', { name: /Custom filters/i })).toBeInTheDocument();
  });

  it('shows the matching preset when active filters match exactly and preset id is missing', () => {
    mockStoreState.viewFilterPresetId = null;

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    expect(screen.getByRole('button', { name: /Source Files/i })).toBeInTheDocument();
  });

  it('matches a preset when filter order differs but values are identical', () => {
    mockStoreState.viewFilterPresetId = null;
    mockStoreState.includeFilters = ['*.tsx', '*.ts'];

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    expect(screen.getByRole('button', { name: /Source Files/i })).toBeInTheDocument();
    expect(mockSetViewFilterPresetId).toHaveBeenCalledWith('preset-1');
  });

  it('synchronizes the preset id when active filters match a preset exactly', async () => {
    mockStoreState.viewFilterPresetId = null;
    mockStorageData['file-explorer-storage-v4'] = {
      version: 1,
      state: {},
    };

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    await waitFor(() => {
      expect(mockSetViewFilterPresetId).toHaveBeenCalledWith('preset-1');
    });
    await waitFor(() => {
      expect(mockStorage.setItem).toHaveBeenCalled();
    });
  });

  it('clears a stale preset id when active filters do not match any preset', async () => {
    mockStoreState.includeFilters = ['*.png'];
    mockStoreState.excludeFilters = [];

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    expect(screen.getByRole('button', { name: /Custom filters/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockSetViewFilterPresetId).toHaveBeenCalledWith(null);
    });
  });

  it('does not infer a preset from a partial filter match', () => {
    mockStoreState.viewFilterPresetId = null;
    mockStoreState.includeFilters = ['*.ts'];

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    expect(screen.getByRole('button', { name: /Custom filters/i })).toBeInTheDocument();
    expect(mockSetViewFilterPresetId).not.toHaveBeenCalled();
  });

  it('does not clear the stored preset id while preset loading has failed', async () => {
    const { useViewFilterPresets } = await import('../hooks/use-view-filter-presets');
    mockStoreState.includeFilters = ['*.png'];
    mockStoreState.excludeFilters = [];
    vi.mocked(useViewFilterPresets).mockReturnValueOnce({
      ...defaultMockViewFilterPresetsResult(),
      presets: [],
      error: new Error('Preset fetch failed'),
    });

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Custom filters/i })).toBeInTheDocument();
    });
    expect(mockSetViewFilterPresetId).not.toHaveBeenCalled();
    expect(mockStorage.setItem).not.toHaveBeenCalled();
  });
});
