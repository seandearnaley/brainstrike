import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { FileExplorerStrings } from '@brainstrike/types';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerToolbar } from '../shell/file-explorer-toolbar';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

function getProps(overrides: Partial<React.ComponentProps<typeof FileExplorerToolbar>> = {}) {
  return {
    isLoading: false,
    onDirectorySelect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('FileExplorerToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a single "Add Folder to Workspace" action button', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    ).toBeInTheDocument();
    // Multi-root: the label no longer flips between "Select Root" and "Add Folder".
    expect(screen.queryByText('Select Root')).not.toBeInTheDocument();
    expect(screen.queryByText('Add Folder')).not.toBeInTheDocument();
  });

  it('preserves the data-testid that desktop E2E depends on', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);
    expect(screen.getByTestId('select-root-button')).toBeInTheDocument();
  });

  it('disables the action button while loading', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps({ isLoading: true })} />);
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    ).toBeDisabled();
  });

  it('invokes onDirectorySelect when the action button is clicked', async () => {
    const props = getProps();
    const user = userEvent.setup();
    renderWithProviders(<FileExplorerToolbar {...props} />);
    await user.click(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    );
    expect(props.onDirectorySelect).toHaveBeenCalledTimes(1);
  });

  it('does not render the focused-root folder badge (removed for multi-root)', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);
    const toolbar = screen.getByTestId('file-explorer-toolbar');
    // Exactly one interactive control: the Add Folder action. No badge alongside it.
    expect(toolbar.querySelectorAll('button')).toHaveLength(1);
  });

  it('centers the action within the toolbar', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);
    expect(screen.getByTestId('file-explorer-toolbar')).toHaveClass('justify-center');
  });
});
