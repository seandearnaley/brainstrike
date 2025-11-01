import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseTab } from '../database-tab';
import { __resetDbPanelStoreForTests, useDbPanelStore } from '../stores/db-panel-store';

vi.mock('../database-tab-chunk', () => ({
  DatabaseTab: () => <div>Database overview chunk</div>,
}));

describe('DatabaseTab', () => {
  beforeEach(() => {
    __resetDbPanelStoreForTests();
  });

  it('shows overview by default and renders lazy chunk', async () => {
    render(<DatabaseTab />);

    expect(screen.getByLabelText('DB subtab')).toHaveValue('overview');
    expect(await screen.findByText('Database overview chunk')).toBeInTheDocument();
  });

  it('allows configuring logs controls', async () => {
    const user = userEvent.setup();
    render(<DatabaseTab />);

    // Wait for the component to render
    await waitFor(() => {
      expect(screen.getByText('View')).toBeInTheDocument();
    });

    const viewRow = screen.getByText('View').closest('div');
    const select = within(viewRow as HTMLElement).getByRole('combobox', { name: 'DB subtab' });
    await user.selectOptions(select, 'logs');

    // Wait for logs controls to appear
    await waitFor(() => {
      expect(screen.getByLabelText('Filter')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Filter'), 'embeddings');
    const sortBy = screen.getByLabelText('Sort By');
    await user.clear(sortBy);
    await user.type(sortBy, 'timestamp');

    const dir = screen.getByLabelText('Direction');
    await user.selectOptions(dir, 'desc');
    const page = screen.getByLabelText('Page');
    await user.clear(page);
    await user.type(page, '2');
    const pageSize = screen.getByLabelText('Page Size');
    await user.clear(pageSize);
    await user.type(pageSize, '25');

    const state = useDbPanelStore.getState();
    expect(state.activeSubtab).toBe('logs');
    expect(state.filterText).toBe('embeddings');
    expect(state.sortBy).toBe('timestamp');
    expect(state.sortDir).toBe('desc');
    expect(state.page).toBeGreaterThan(1);
    expect(state.pageSize).toBeGreaterThan(10);
  }, 10000);
});
