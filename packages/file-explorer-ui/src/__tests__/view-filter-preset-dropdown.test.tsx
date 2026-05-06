import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import type { ViewFilterPreset } from '@brainstrike/types';
import { TooltipProvider } from '@brainstrike/ui';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewFilterPresetDropdown } from '../view-filter-preset-dropdown';

const Wrapper = composeWrappers(({ children }) => <TooltipProvider>{children}</TooltipProvider>);
const renderWithProviders = makeRenderWithProviders(Wrapper);

const mockPresets: ViewFilterPreset[] = [
  {
    id: 'preset-1',
    name: 'Source Files',
    description: 'TypeScript and JavaScript files',
    icon: 'file-code',
    includes: ['*.ts', '*.tsx', '*.js', '*.jsx'],
    excludes: ['node_modules', 'dist'],
    useRegex: false,
    isDefault: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'preset-2',
    name: 'Documentation',
    description: 'Markdown and text files',
    icon: 'file-text',
    includes: ['*.md', '*.txt'],
    excludes: [],
    useRegex: false,
    isDefault: false,
    sortOrder: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

describe('ViewFilterPresetDropdown', () => {
  const mockOnSelect = vi.fn();
  const mockOnCreate = vi.fn();
  const mockOnUpdate = vi.fn();
  const mockOnDelete = vi.fn();

  const defaultProps = {
    presets: mockPresets,
    selectedPreset: null,
    onSelect: mockOnSelect,
    onCreate: mockOnCreate,
    onUpdate: mockOnUpdate,
    onDelete: mockOnDelete,
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnCreate.mockResolvedValue(mockPresets[0]);
    mockOnUpdate.mockResolvedValue(mockPresets[0]);
    mockOnDelete.mockResolvedValue(true);
  });

  it('renders with placeholder when no preset selected', () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    expect(screen.getByRole('button')).toHaveTextContent('Select filter...');
  });

  it('renders with selected preset name', () => {
    renderWithProviders(
      <ViewFilterPresetDropdown {...defaultProps} selectedPreset={mockPresets[0] || null} />
    );
    expect(screen.getByRole('button')).toHaveTextContent('Source Files');
  });

  it('opens dropdown on click and shows presets', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    expect(screen.getByText('Source Files')).toBeInTheDocument();
    expect(screen.getByText('Documentation')).toBeInTheDocument();
  });

  it('shows search input when dropdown is open', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    expect(screen.getByPlaceholderText('Filter presets...')).toBeInTheDocument();
  });

  it('filters presets based on search', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    const searchInput = screen.getByPlaceholderText('Filter presets...');
    await userEvent.type(searchInput, 'Source');

    expect(screen.getByText('Source Files')).toBeInTheDocument();
    expect(screen.queryByText('Documentation')).not.toBeInTheDocument();
  });

  it('calls onSelect when a preset is clicked', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    // Click the preset text
    const presetButton = screen.getByText('Source Files');
    await userEvent.click(presetButton);

    expect(mockOnSelect).toHaveBeenCalledWith(mockPresets[0] || null);
  });

  it('selects the single filtered preset with Enter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);

    await user.click(screen.getByRole('button'));
    await user.type(screen.getByRole('textbox', { name: /filter presets/i }), 'Documentation');
    await user.keyboard('{Enter}');

    expect(mockOnSelect).toHaveBeenCalledWith(mockPresets[1] || null);
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: /filter presets/i })).not.toBeInTheDocument();
    });
  });

  it('shows check mark for selected preset', async () => {
    renderWithProviders(
      <ViewFilterPresetDropdown {...defaultProps} selectedPreset={mockPresets[0] || null} />
    );
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    // The selected preset row should have bg-accent/50 class
    // Find all elements with 'Source Files' text and get the one in the dropdown list
    const sourceFilesElements = screen.getAllByText('Source Files');
    // The second one is in the dropdown list (first is in the trigger button)
    const listItem = sourceFilesElements[1]?.closest('div[class*="group"]');
    expect(listItem).toHaveClass('bg-accent/50');
  });

  it('shows create new preset button', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    expect(screen.getByText('Create New Preset')).toBeInTheDocument();
  });

  it('shows create form when Create New Preset is clicked', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    const createButton = screen.getByText('Create New Preset');
    await userEvent.click(createButton);

    expect(screen.getByText('New Preset')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. My Custom Filter')).toBeInTheDocument();
  });

  it('creates new preset with form data', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    // Open create form
    const createButton = screen.getByText('Create New Preset');
    await userEvent.click(createButton);

    // Fill the form
    const nameInput = screen.getByPlaceholderText('e.g. My Custom Filter');
    await userEvent.type(nameInput, 'Test Preset');

    const includesInput = screen.getByPlaceholderText('*.ts, src/**');
    await userEvent.type(includesInput, '*.test.ts');

    // Save
    const saveButton = screen.getByRole('button', { name: 'Save & Select' });
    await userEvent.click(saveButton);

    await waitFor(() => {
      expect(mockOnCreate).toHaveBeenCalledWith({
        name: 'Test Preset',
        icon: 'file',
        includes: ['*.test.ts'],
        excludes: [],
        useRegex: false,
      });
    });
  });

  it('keeps the trigger enabled when presets are still loading', () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} loading={true} />);
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('shows loading feedback inside the dropdown while presets are loading', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} loading={true} presets={[]} />);

    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Loading presets...')).toBeInTheDocument();
    expect(screen.queryByText('No presets found')).not.toBeInTheDocument();
  });

  it('shows empty state when no presets match search', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    const searchInput = screen.getByPlaceholderText('Filter presets...');
    await userEvent.type(searchInput, 'nonexistent');

    expect(screen.getByText('No presets found')).toBeInTheDocument();
  });

  it('shows edit button on preset hover', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    // The edit buttons exist but are hidden until hover (opacity-0)
    const editButtons = document.querySelectorAll('[class*="opacity-0"]');
    expect(editButtons.length).toBeGreaterThan(0);
  });

  it('closes dropdown when X is clicked in create mode', async () => {
    renderWithProviders(<ViewFilterPresetDropdown {...defaultProps} />);
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);

    // Open create form
    const createButton = screen.getByText('Create New Preset');
    await userEvent.click(createButton);

    expect(screen.getByText('New Preset')).toBeInTheDocument();

    // Click X to close create mode (go back to list)
    const closeButtons = screen.getAllByRole('button').filter((btn) => {
      const svg = btn.querySelector('svg');
      return svg && btn.classList.contains('size-5');
    });
    if (closeButtons[0]) {
      await userEvent.click(closeButtons[0]);
    }

    // Should be back to list view
    expect(screen.queryByText('New Preset')).not.toBeInTheDocument();
    expect(screen.getByText('Source Files')).toBeInTheDocument();
  });
});
