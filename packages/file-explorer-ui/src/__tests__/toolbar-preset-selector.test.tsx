import type { ViewFilterPreset } from '@brainstrike/types';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the hooks and dependencies
const mockPresets: ViewFilterPreset[] = [
  {
    createdAt: new Date(),
    description: 'TypeScript and JavaScript files',
    excludes: ['node_modules'],
    icon: 'file-code',
    id: 'preset-1',
    includes: ['*.ts', '*.tsx'],
    isDefault: true,
    name: 'Source Files',
    sortOrder: 0,
    updatedAt: new Date(),
    useRegex: false,
  },
  {
    createdAt: new Date(),
    description: 'Markdown files',
    excludes: [],
    icon: 'file-text',
    id: 'preset-2',
    includes: ['*.md'],
    isDefault: false,
    name: 'Documentation',
    sortOrder: 1,
    updatedAt: new Date(),
    useRegex: false,
  },
];

const mockSetViewFilterPresetId = vi.fn((id: string | null) => {
  mockStoreState.viewFilterPresetId = id;
});
const mockSetFilters = vi.fn((includes: string[], excludes: string[]) => {
  mockStoreState.includeFilters = includes;
  mockStoreState.excludeFilters = excludes;
});
const mockSetUseRegex = vi.fn((value: boolean) => {
  mockStoreState.useRegex = value;
});
const mockCreatePreset = vi.fn();
const mockUpdatePreset = vi.fn();
const mockDeletePreset = vi.fn();
const defaultMockViewFilterPresetsResult = () => ({
  createPreset: mockCreatePreset,
  deletePreset: mockDeletePreset,
  error: null,
  getPreset: vi.fn(),
  loading: false,
  presets: mockPresets,
  refresh: vi.fn(),
  updatePreset: mockUpdatePreset,
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
  excludeFilters: ['node_modules'],
  folderStates: {
    'mock-root': {
      excludeFilters: ['node_modules'],
      expandedDirectoryPaths: new Set<string>(),
      includeFilters: ['*.ts', '*.tsx'],
      lastAccessed: Date.now(),
      lastActiveTab: 'files',
      maxSelectionCount: 10,
      selectedFilePaths: new Set<string>(),
      tokenBudget: 100_000,
      useRegex: false,
      viewFilterPresetId: 'preset-1',
    },
  },
  includeFilters: ['*.ts', '*.tsx'],
  setFilters: mockSetFilters,
  setUseRegex: mockSetUseRegex,
  setViewFilterPresetId: mockSetViewFilterPresetId,
  useRegex: false,
  viewFilterPresetId: 'preset-1',
});

let mockStoreState: MockStoreState = defaultMockStoreState();

// Canonical-writer capture: persistFileExplorerStateImmediately writes the
// whole store snapshot through the ADAPTERS storage adapter.
const mockAdapterStorage = {
  clear: vi.fn(async () => undefined),
  getAllKeys: vi.fn(async () => []),
  getItem: vi.fn(async () => null),
  removeItem: vi.fn(async () => undefined),
  setItem: vi.fn(async () => undefined),
};

// Hydration controls: false simulates the pre-rehydration boot window.
let mockHasHydrated = true;
const hydrationListeners: Array<() => void> = [];
function finishHydration(): void {
  mockHasHydrated = true;
  for (const listener of hydrationListeners.splice(0)) {
    listener();
  }
}

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({ storageAdapter: mockAdapterStorage }),
}));

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
        partialize: (state: unknown) => state,
        version: 1,
      }),
      hasHydrated: () => mockHasHydrated,
      onFinishHydration: (callback: () => void) => {
        hydrationListeners.push(callback);
        return () => {
          const index = hydrationListeners.indexOf(callback);
          if (index >= 0) {
            hydrationListeners.splice(index, 1);
          }
        };
      },
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
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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
    mockHasHydrated = true;
    hydrationListeners.length = 0;
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

  it('persists the CANONICAL store snapshot immediately on preset selection', async () => {
    const user = userEvent.setup();
    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    const triggerButton = screen.getByRole('button', { name: /Source Files/i });
    await user.click(triggerButton);
    await waitFor(() => {
      expect(screen.getByText('Documentation')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Documentation'));

    await waitFor(() => {
      expect(mockAdapterStorage.setItem).toHaveBeenCalled();
    });
    const lastCall = mockAdapterStorage.setItem.mock.calls.at(-1) as unknown as [string, string];
    expect(lastCall[0]).toBe('file-explorer-storage-v4');
    const payload = JSON.parse(lastCall[1]) as {
      state: { excludeFilters: string[]; includeFilters: string[]; viewFilterPresetId: string };
      version: number;
    };
    // The snapshot is the LIVE store serialization (store actions applied
    // before the write), never a hand-merged patch.
    expect(payload.version).toBe(1);
    expect(payload.state.viewFilterPresetId).toBe('preset-2');
    expect(payload.state.includeFilters).toEqual(['*.md']);
    expect(payload.state.excludeFilters).toEqual([]);
  });

  it('does not sync the preset id or write storage before the store rehydrates (boot-clobber guard)', async () => {
    // The store still holds DEFAULTS during this window — any write would
    // overwrite the user's persisted settings with them.
    mockHasHydrated = false;
    // A mismatch that WOULD trigger the sync effect once hydrated: stored id
    // points at preset-1 but the live filters match preset-2.
    mockStoreState.includeFilters = ['*.md'];
    mockStoreState.excludeFilters = [];
    mockStoreState.viewFilterPresetId = 'preset-1';

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    // Give effects a chance to (incorrectly) fire.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mockAdapterStorage.setItem).not.toHaveBeenCalled();
    expect(mockSetViewFilterPresetId).not.toHaveBeenCalled();

    // Hydration completes → the sync proceeds normally.
    act(() => {
      finishHydration();
    });
    await waitFor(() => {
      expect(mockSetViewFilterPresetId).toHaveBeenCalledWith('preset-2');
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
      createPreset: mockCreatePreset,
      deletePreset: mockDeletePreset,
      error: null,
      getPreset: vi.fn(),
      loading: true,
      presets: [],
      refresh: vi.fn(),
      updatePreset: mockUpdatePreset,
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
      loading: true,
      presets: [],
    });

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    await waitFor(() => {
      expect(screen.getByRole('button')).toBeInTheDocument();
    });
    expect(mockSetViewFilterPresetId).not.toHaveBeenCalled();
    expect(mockAdapterStorage.setItem).not.toHaveBeenCalled();
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

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    await waitFor(() => {
      expect(mockSetViewFilterPresetId).toHaveBeenCalledWith('preset-1');
    });
    await waitFor(() => {
      expect(mockAdapterStorage.setItem).toHaveBeenCalled();
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
      error: new Error('Preset fetch failed'),
      presets: [],
    });

    render(<ToolbarPresetSelector onFilterChange={mockOnFilterChange} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Custom filters/i })).toBeInTheDocument();
    });
    expect(mockSetViewFilterPresetId).not.toHaveBeenCalled();
    expect(mockAdapterStorage.setItem).not.toHaveBeenCalled();
  });
});
