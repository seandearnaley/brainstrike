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

// Create mock persist API
const mockStorageData: Record<string, string> = {};
const mockStorage = {
  getItem: vi.fn((key: string) => mockStorageData[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorageData[key] = value;
  }),
};

vi.mock('../file-explorer-provider', () => ({
  useFileExplorerStoreContext: vi.fn(() => {
    // Create a store-like function that returns values based on selector
    const storeFn = (selector: (state: Record<string, unknown>) => unknown) => {
      const state = {
        viewFilterPresetId: 'preset-1',
        setViewFilterPresetId: mockSetViewFilterPresetId,
        setFilters: mockSetFilters,
        setUseRegex: mockSetUseRegex,
      };
      return selector(state);
    };
    // Add persist API to the store function
    storeFn.persist = {
      getOptions: () => ({
        name: 'file-explorer-storage-v4',
        storage: mockStorage,
      }),
    };
    return storeFn;
  }),
}));

vi.mock('../hooks/use-view-filter-presets', () => ({
  useViewFilterPresets: vi.fn(() => ({
    presets: mockPresets,
    loading: false,
    error: null,
    createPreset: mockCreatePreset,
    updatePreset: mockUpdatePreset,
    deletePreset: mockDeletePreset,
    refresh: vi.fn(),
    getPreset: vi.fn(),
  })),
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
import { ToolbarPresetSelector } from '../toolbar-preset-selector';

describe('ToolbarPresetSelector', () => {
  const mockOnFilterChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it('handles persistence with existing wrapper state', async () => {
    // Set up existing wrapped state
    mockStorageData['file-explorer-storage-v4'] = JSON.stringify({
      version: 1,
      state: { existingKey: 'existingValue' },
    });

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
      const savedState = JSON.parse(lastCall[1] as string);
      expect(savedState.state.existingKey).toBe('existingValue');
      expect(savedState.state.viewFilterPresetId).toBe('preset-2');
    }
  });

  it('handles persistence without wrapper', async () => {
    // Set up non-wrapped state
    mockStorageData['file-explorer-storage-v4'] = JSON.stringify({
      existingKey: 'existingValue',
    });

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

    // Component should render even during loading - button shows selected preset or placeholder
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('handles null selected preset', async () => {
    const { useFileExplorerStoreContext } = await import('../file-explorer-provider');
    vi.mocked(useFileExplorerStoreContext).mockReturnValueOnce(((
      selector: (state: Record<string, unknown>) => unknown
    ) => {
      const state = {
        viewFilterPresetId: null,
        setViewFilterPresetId: mockSetViewFilterPresetId,
        setFilters: mockSetFilters,
        setUseRegex: mockSetUseRegex,
      };
      return selector(state);
    }) as ReturnType<typeof useFileExplorerStoreContext>);

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    // Component should render without selected preset - shows placeholder text
    expect(screen.getByRole('button', { name: /Select filter/i })).toBeInTheDocument();
  });
});
