import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { FileExplorerStrings } from '@brainstrike/types';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceSettings from '../workspace-settings';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

describe('WorkspaceSettings', () => {
  const defaultProps = {
    filterError: null,
    onFilterChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders settings button', () => {
    act(() => {
      renderWithProviders(<WorkspaceSettings {...defaultProps} />);
    });
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('opens dialog on button click', async () => {
    act(() => {
      renderWithProviders(<WorkspaceSettings {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows workspace settings title in dialog', async () => {
    act(() => {
      renderWithProviders(<WorkspaceSettings {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);

    expect(screen.getByText('Workspace Settings')).toBeInTheDocument();
  });

  // Note: View Filter Preset dropdown was moved to the toolbar
  // See toolbar-preset-selector.test.tsx for preset dropdown tests

  it('does not render include-project-tree toggle inside workspace settings', async () => {
    act(() => {
      renderWithProviders(<WorkspaceSettings {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);

    expect(
      screen.queryByRole('switch', {
        name: /Include Project Tree/i,
      })
    ).not.toBeInTheDocument();
  });

  // Note: Folder Summary Threshold was moved to the Preview Panel footer
  // See preview-panel.test.tsx for folder summary threshold tests

  // Note: Max Selection Count was moved to the Selection Counter component
  // See selection-counter.test.tsx for max selection count tests

  it('shows inline fixture toggle when available', async () => {
    renderWithProviders(
      <WorkspaceSettings
        {...defaultProps}
        inlineFixtureSetting={{ available: true, loading: false }}
      />
    );
    const button = screen.getByRole('button');
    await userEvent.click(button);

    expect(
      screen.getByRole('switch', { name: FileExplorerStrings.inlineFixture.settingLabel })
    ).toBeInTheDocument();
  });

  it('applies settings and closes dialog', async () => {
    const mockOnFilterChange = vi.fn();
    act(() => {
      renderWithProviders(
        <WorkspaceSettings {...defaultProps} onFilterChange={mockOnFilterChange} />
      );
    });

    const button = screen.getByRole('button');
    await userEvent.click(button);

    // Click apply
    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Verify settings were applied
    expect(mockOnFilterChange).toHaveBeenCalled();

    // Verify dialog is closed (wait for async operations to complete)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows forget stored folders button when handler is provided', async () => {
    const mockForgetFolders = vi.fn();
    renderWithProviders(
      <WorkspaceSettings
        {...defaultProps}
        hasStoredFolders={true}
        onForgetStoredFolders={mockForgetFolders}
      />
    );
    const button = screen.getByRole('button');
    await userEvent.click(button);

    expect(screen.getByText('Forget all folders')).toBeInTheDocument();
  });

  it('disables forget folders button when no stored folders', async () => {
    const mockForgetFolders = vi.fn();
    renderWithProviders(
      <WorkspaceSettings
        {...defaultProps}
        hasStoredFolders={false}
        onForgetStoredFolders={mockForgetFolders}
      />
    );
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const forgetButton = screen.getByText('Forget all folders');
    expect(forgetButton.closest('button')).toBeDisabled();
  });
});
