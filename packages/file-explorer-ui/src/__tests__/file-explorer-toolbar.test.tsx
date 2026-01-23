import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { FileExplorerStrings } from '@brainstrike/types';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerToolbar } from '../file-explorer-toolbar';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

function getProps(overrides: Partial<React.ComponentProps<typeof FileExplorerToolbar>> = {}) {
  return {
    onDirectorySelect: vi.fn().mockResolvedValue(undefined),
    onFilterChange: vi.fn(),
    filterError: null,
    isLoading: false,
    ...overrides,
  };
}

describe('FileExplorerToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders select root button', () => {
    const props = getProps();
    renderWithProviders(<FileExplorerToolbar {...props} />);
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.selectRoot })
    ).toBeInTheDocument();
  });

  it('disables select root button based on loading state', () => {
    const props = getProps({ isLoading: true });
    renderWithProviders(<FileExplorerToolbar {...props} />);
    expect(screen.getByRole('button', { name: FileExplorerStrings.selectRoot })).toBeDisabled();
  });

  it('invokes callback when select root button is clicked', async () => {
    const props = getProps();
    const user = userEvent.setup();
    renderWithProviders(<FileExplorerToolbar {...props} />);
    await user.click(screen.getByRole('button', { name: FileExplorerStrings.selectRoot }));
    expect(props.onDirectorySelect).toHaveBeenCalledTimes(1);
  });
});
