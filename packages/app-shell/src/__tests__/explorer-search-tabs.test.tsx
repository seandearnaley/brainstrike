import { useContextExplorerLayoutStore } from '@brainstrike/preferences/stores/context-explorer-layout-store';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  FileExplorerPanel: () => <div data-testid="file-explorer-panel-mock" />,
}));

vi.mock('@brainstrike/workspace-search', () => ({
  WorkspaceSearchPanel: () => <div data-testid="workspace-search-panel-mock" />,
}));

vi.mock('../use-workspace-search-controller', () => ({
  useWorkspaceSearchController: () => ({
    onOpenFile: vi.fn(),
    resolveAdapterRootId: () => null,
    runSemanticSearch: vi.fn(),
    runTextSearch: vi.fn(),
    workspaceDbRootIds: [],
  }),
}));

import { ExplorerSearchTabs } from '../explorer-search-tabs';

describe('ExplorerSearchTabs', () => {
  beforeEach(() => {
    useContextExplorerLayoutStore.getState().setExplorerActiveTab('explorer');
  });

  it('renders both tabs with Explorer selected by default and Search not yet mounted', () => {
    render(<ExplorerSearchTabs />);

    const explorerTab = screen.getByRole('tab', { name: 'Explorer' });
    const searchTab = screen.getByRole('tab', { name: 'Search' });
    expect(explorerTab).toHaveAttribute('aria-selected', 'true');
    expect(searchTab).toHaveAttribute('aria-selected', 'false');

    expect(screen.getByTestId('file-explorer-panel-mock')).toBeInTheDocument();
    // Lazy: Search content only mounts on first activation.
    expect(screen.queryByTestId('workspace-search-panel-mock')).not.toBeInTheDocument();
  });

  it('switches to Search, keeps Explorer mounted, and persists the active tab', async () => {
    const user = userEvent.setup();
    render(<ExplorerSearchTabs />);

    await user.click(screen.getByRole('tab', { name: 'Search' }));

    // Search lazy-mounts.
    await waitFor(() => {
      expect(screen.getByTestId('workspace-search-panel-mock')).toBeInTheDocument();
    });

    expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
    // Explorer STAYS mounted (only hidden) so its tree state survives.
    expect(screen.getByTestId('file-explorer-panel-mock')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-search-panel-explorer')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    expect(screen.getByTestId('explorer-search-panel-search')).toHaveAttribute(
      'aria-hidden',
      'false'
    );

    // Persisted through the layout store.
    expect(useContextExplorerLayoutStore.getState().explorerActiveTab).toBe('search');
  });

  it('keeps the Search panel mounted after switching back to Explorer', async () => {
    const user = userEvent.setup();
    render(<ExplorerSearchTabs />);

    await user.click(screen.getByRole('tab', { name: 'Search' }));
    await waitFor(() => {
      expect(screen.getByTestId('workspace-search-panel-mock')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('tab', { name: 'Explorer' }));

    expect(screen.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('aria-selected', 'true');
    // Search panel remains mounted (mounted-once latch), just hidden.
    expect(screen.getByTestId('workspace-search-panel-mock')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-search-panel-search')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
  });
});
