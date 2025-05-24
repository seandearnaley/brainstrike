import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerToolbar } from '../file-explorer-toolbar';
import { FileExplorerTestWrapper } from './test-helpers';

function getProps(overrides: Partial<React.ComponentProps<typeof FileExplorerToolbar>> = {}) {
  return {
    onDirectorySelect: vi.fn().mockResolvedValue(undefined),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onFilterChange: vi.fn(),
    filterError: null,
    maxSelectionCount: 10,
    quickFilter: '',
    setQuickFilter: vi.fn(),
    clearQuickFilter: vi.fn(),
    isLoading: false,
    isRefreshing: false,
    rootDirectoryHandle: {
      kind: 'directory',
      name: 'root',
      path: '/test/root',
      platform: 'web',
    } as DirectoryHandle,
    onExpandAll: vi.fn(),
    onCollapseAll: vi.fn(),
    ...overrides,
  };
}

describe('FileExplorerToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders buttons and filter bar when root directory is present', () => {
    const props = getProps();
    render(<FileExplorerToolbar {...props} />, { wrapper: FileExplorerTestWrapper });
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.selectRoot })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: FileExplorerStrings.refresh })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse All' })).toBeInTheDocument();
    // Filter bar should appear when root directory handle exists
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('does not show filter bar without a root directory', () => {
    const props = getProps({ rootDirectoryHandle: null });
    render(<FileExplorerToolbar {...props} />, { wrapper: FileExplorerTestWrapper });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('disables buttons based on loading state', () => {
    const props = getProps({ isLoading: true });
    render(<FileExplorerToolbar {...props} />, { wrapper: FileExplorerTestWrapper });
    expect(screen.getByRole('button', { name: FileExplorerStrings.selectRoot })).toBeDisabled();
    expect(screen.getByRole('button', { name: FileExplorerStrings.refresh })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Expand All' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Collapse All' })).toBeDisabled();
  });

  it('shows spinning refresh icon and disables buttons when refreshing', () => {
    const props = getProps({ isRefreshing: true });
    render(<FileExplorerToolbar {...props} />, { wrapper: FileExplorerTestWrapper });
    const refreshButton = screen.getByRole('button', { name: FileExplorerStrings.refresh });
    expect(refreshButton).toBeDisabled();
    // Directory select should remain enabled while refreshing
    expect(screen.getByRole('button', { name: FileExplorerStrings.selectRoot })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Expand All' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Collapse All' })).toBeDisabled();
    const icon = refreshButton.querySelector('svg');
    expect(icon?.classList.contains('animate-spin')).toBe(true);
  });

  it('invokes callbacks when buttons are clicked', async () => {
    const props = getProps();
    const user = userEvent.setup();
    render(<FileExplorerToolbar {...props} />, { wrapper: FileExplorerTestWrapper });
    await user.click(screen.getByRole('button', { name: FileExplorerStrings.selectRoot }));
    await user.click(screen.getByRole('button', { name: FileExplorerStrings.refresh }));
    await user.click(screen.getByRole('button', { name: 'Expand All' }));
    await user.click(screen.getByRole('button', { name: 'Collapse All' }));
    expect(props.onDirectorySelect).toHaveBeenCalledTimes(1);
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    expect(props.onExpandAll).toHaveBeenCalledTimes(1);
    expect(props.onCollapseAll).toHaveBeenCalledTimes(1);
  });
});
