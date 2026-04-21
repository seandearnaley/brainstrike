import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSidebarPanel } from '../agent-sidebar-panel';

const { mockPreloadDatabaseTab } = vi.hoisted(() => ({
  mockPreloadDatabaseTab: vi.fn(() => Promise.resolve()),
}));

vi.mock('../database-tab', () => ({
  preloadDatabaseTab: mockPreloadDatabaseTab,
}));

describe('AgentSidebarPanel', () => {
  beforeEach(() => {
    mockPreloadDatabaseTab.mockClear();
  });

  it('shows threads first and reveals database content when the database tab is selected', async () => {
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(screen.getByRole('tab', { name: 'Threads' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Threads content')).toBeVisible();
    expect(screen.queryByText('Database content')).not.toBeInTheDocument();

    const databaseTab = screen.getByRole('tab', { name: 'Database' });
    fireEvent.mouseDown(databaseTab, { button: 0, ctrlKey: false });

    await waitFor(() => {
      expect(databaseTab).toHaveAttribute('data-state', 'active');
    });
    expect(await screen.findByText('Database content')).toBeVisible();
  });

  it('preloads the database chunk when requested', async () => {
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        preloadDatabaseTabOnMount
        threadsContent={<div>Threads content</div>}
      />
    );

    await waitFor(() => {
      expect(mockPreloadDatabaseTab).toHaveBeenCalledTimes(1);
    });
  });

  it('prefetches the database chunk on pointer and keyboard intent', async () => {
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    const databaseTab = screen.getByRole('tab', { name: 'Database' });

    fireEvent.pointerEnter(databaseTab);
    fireEvent.focus(databaseTab);

    await waitFor(() => {
      expect(mockPreloadDatabaseTab).toHaveBeenCalledTimes(1);
    });
  });
});
