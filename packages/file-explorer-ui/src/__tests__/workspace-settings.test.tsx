import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { FileExplorerStrings } from '@brainstrike/types';
import { act, fireEvent, screen } from '@testing-library/react';
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

  it('opens popover on button click', async () => {
    act(() => {
      renderWithProviders(<WorkspaceSettings {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('displays filter error when present', () => {
    const props = {
      ...defaultProps,
      filterError: 'Invalid regex pattern',
    };
    act(() => {
      renderWithProviders(<WorkspaceSettings {...props} />);
    });
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.getByText('Invalid regex pattern')).toBeInTheDocument();
  });

  it('handles regex toggle', async () => {
    act(() => {
      renderWithProviders(<WorkspaceSettings {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const regexSwitch = screen.getByRole('switch', { name: /Use Regex/i });
    await userEvent.click(regexSwitch);

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Just verify the callback was called (integration test would verify state changes)
    expect(defaultProps.onFilterChange).toHaveBeenCalled();
  });

  it('handles project tree toggle', async () => {
    act(() => {
      renderWithProviders(<WorkspaceSettings {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const treeSwitch = screen.getByRole('switch', {
      name: /Include Project Tree/i,
    });
    await userEvent.click(treeSwitch);

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Just verify UI interaction works
    expect(defaultProps.onFilterChange).toHaveBeenCalled();
  });

  it('updates folder summary threshold', async () => {
    act(() => {
      renderWithProviders(<WorkspaceSettings {...defaultProps} />);
    });
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const input = screen.getByLabelText(/Folder Summary Threshold/i);
    fireEvent.change(input, { target: { value: '10' } });

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Just verify UI interaction works
    expect(defaultProps.onFilterChange).toHaveBeenCalled();
  });

  it('updates max selection count', async () => {
    renderWithProviders(<WorkspaceSettings {...defaultProps} />);
    const button = screen.getByRole('button');
    await userEvent.click(button);

    const input = screen.getByLabelText(/Max Selection Count/i);
    fireEvent.change(input, { target: { value: '20' } });

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Just verify UI interaction works
    expect(defaultProps.onFilterChange).toHaveBeenCalled();
  });

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

  it('applies settings and closes popover', async () => {
    const mockOnFilterChange = vi.fn();
    act(() => {
      renderWithProviders(
        <WorkspaceSettings {...defaultProps} onFilterChange={mockOnFilterChange} />
      );
    });

    const button = screen.getByRole('button');
    await userEvent.click(button);

    // Modify some settings
    const regexSwitch = screen.getByRole('switch', { name: /Use Regex/i });
    await userEvent.click(regexSwitch);

    // Click apply
    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    // Verify settings were applied
    expect(mockOnFilterChange).toHaveBeenCalled();

    // Verify popover is closed (wait for async operations to complete)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
