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
    bulkSelectionControl: <button type="button">Select all files</button>,
    isLoading: false,
    onDirectorySelect: vi.fn().mockResolvedValue(undefined),
    selectionStatusControl: <output>0 of 10 selected</output>,
    ...overrides,
  };
}

describe('FileExplorerToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one Add Folder action alongside the selection controls', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    ).toBeInTheDocument();
    // Multi-root: the label no longer flips between "Select Root" and "Add Folder".
    expect(screen.queryByText('Select Root')).not.toBeInTheDocument();
    expect(screen.queryByText('Add Folder')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select all files' })).toBeInTheDocument();
    expect(screen.getByText('0 of 10 selected')).toBeInTheDocument();
  });

  it('orders selection status left, Add Folder centered, and bulk selection right', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);

    const toolbar = screen.getByTestId('file-explorer-toolbar');
    const [leftSlot, centerSlot, rightSlot] = Array.from(toolbar.children);
    const selectionStatus = screen.getByText('0 of 10 selected');
    const addFolderButton = screen.getByRole('button', {
      name: FileExplorerStrings.addFolderToWorkspace,
    });
    const bulkSelectionButton = screen.getByRole('button', { name: 'Select all files' });

    expect(leftSlot).toContainElement(selectionStatus);
    expect(leftSlot).toHaveClass('justify-start');
    expect(centerSlot).toBe(addFolderButton);
    expect(rightSlot).toContainElement(bulkSelectionButton);
    expect(rightSlot).toHaveClass('justify-end');
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
    expect(toolbar).not.toHaveTextContent(/focused root/i);
  });

  it('uses a stable 48px centered toolbar and an accented reduced-motion-safe primary action', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);
    const toolbar = screen.getByTestId('file-explorer-toolbar');

    expect(toolbar.parentElement).toHaveClass(
      '@container/explorer-toolbar',
      'h-12',
      'overflow-hidden',
      'border-b'
    );
    expect(toolbar).toHaveClass('h-full', 'grid', 'gap-0');
    expect(toolbar).not.toHaveClass('@[96px]/explorer-toolbar:gap-0.5');
    const [leftSlot, , rightSlot] = Array.from(toolbar.children);
    expect(leftSlot).toHaveClass('@container/explorer-selection');
    expect(rightSlot).toHaveClass('@container/explorer-bulk');
    expect(leftSlot?.firstElementChild).toHaveClass(
      'pl-1',
      '@[96px]/explorer-toolbar:pl-1.5',
      '@[128px]/explorer-toolbar:pl-3'
    );
    expect(rightSlot?.firstElementChild).toHaveClass(
      'pr-1',
      '@[96px]/explorer-toolbar:pr-1.5',
      '@[128px]/explorer-toolbar:pr-3'
    );
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    ).toHaveClass(
      'border-primary/40',
      'bg-primary/10',
      'motion-reduce:transition-none',
      'size-6',
      '@[96px]/explorer-toolbar:size-7',
      '@[128px]/explorer-toolbar:size-8'
    );
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    ).toHaveAttribute('data-size', 'icon-xs');
  });
});
