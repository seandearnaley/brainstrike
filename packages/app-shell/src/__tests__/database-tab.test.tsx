import { fireEvent, render, screen, within } from '@testing-library/react';
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
    render(<DatabaseTab />);

    const viewRow = screen.getByText('View').closest('div');
    const select = within(viewRow as HTMLElement).getByRole('combobox', { name: 'DB subtab' });
    fireEvent.change(select, { target: { value: 'logs' } });

    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'embeddings' } });
    const sortBy = screen.getByLabelText('Sort By');
    fireEvent.change(sortBy, { target: { value: '' } });
    fireEvent.change(sortBy, { target: { value: 'timestamp' } });

    const dir = screen.getByLabelText('Direction');
    fireEvent.change(dir, { target: { value: 'desc' } });
    const page = screen.getByLabelText('Page');
    fireEvent.change(page, { target: { value: '' } });
    fireEvent.change(page, { target: { value: '2' } });
    const pageSize = screen.getByLabelText('Page Size');
    fireEvent.change(pageSize, { target: { value: '' } });
    fireEvent.change(pageSize, { target: { value: '25' } });

    const state = useDbPanelStore.getState();
    expect(state.activeSubtab).toBe('logs');
    expect(state.filterText).toBe('embeddings');
    expect(state.sortBy).toBe('timestamp');
    expect(state.sortDir).toBe('desc');
    expect(state.page).toBeGreaterThan(1);
    expect(state.pageSize).toBeGreaterThan(10);
  });
});
