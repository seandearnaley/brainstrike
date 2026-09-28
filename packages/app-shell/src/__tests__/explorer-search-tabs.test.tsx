import { useContextExplorerLayoutStore } from '@brainstrike/app-state/stores/context-explorer-layout-store';
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

  it('renders both tabs through the shared Tabs primitive with Explorer selected by default and Search not yet mounted', () => {
    render(<ExplorerSearchTabs />);

    const explorerTab = screen.getByRole('tab', { name: 'Explorer' });
    const searchTab = screen.getByRole('tab', { name: 'Search' });
    expect(screen.getByTestId('explorer-search-tab-strip')).toHaveClass('h-9');
    // Converged on the same shared segmented Tabs primitive the Library uses.
    expect(explorerTab).toHaveAttribute('data-slot', 'tabs-trigger');
    expect(searchTab).toHaveAttribute('data-slot', 'tabs-trigger');
    // Geometry comes from the shared panel-header (sm) variant.
    expect(explorerTab).toHaveAttribute('data-size', 'sm');
    expect(searchTab).toHaveAttribute('data-size', 'sm');
    const tablist = screen.getByRole('tablist', { name: 'Explorer and search' });
    expect(tablist).toHaveAttribute('data-slot', 'tabs-list');
    expect(tablist).toHaveAttribute('data-size', 'sm');
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
    expect(screen.getByTestId('explorer-search-panel-explorer')).not.toBeVisible();
    expect(screen.getByTestId('explorer-search-panel-search')).toBeVisible();

    // Persisted through the layout store.
    expect(useContextExplorerLayoutStore.getState().explorerActiveTab).toBe('search');
  });

  it('does not activate or mount Search from keyboard roving alone', async () => {
    const user = userEvent.setup();
    render(<ExplorerSearchTabs />);

    screen.getByRole('tab', { name: 'Explorer' }).focus();
    await user.keyboard('{ArrowRight}');

    // Manual activation: focus roves without selecting, so the expensive
    // Search panel is neither latched nor lazily downloaded.
    expect(screen.getByRole('tab', { name: 'Search' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByTestId('workspace-search-panel-mock')).not.toBeInTheDocument();
    expect(useContextExplorerLayoutStore.getState().explorerActiveTab).toBe('explorer');
  });

  it('restores a persisted Search tab with Search mounted and Explorer mounted but hidden', async () => {
    useContextExplorerLayoutStore.getState().setExplorerActiveTab('search');
    render(<ExplorerSearchTabs />);

    expect(await screen.findByTestId('workspace-search-panel-mock')).toBeVisible();
    expect(screen.getByTestId('file-explorer-panel-mock')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-search-panel-explorer')).not.toBeVisible();
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
    expect(screen.getByTestId('explorer-search-panel-search')).not.toBeVisible();
    expect(screen.getByTestId('explorer-search-panel-explorer')).toBeVisible();
  });
});
