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
    window.localStorage.clear();
  });

  it('shows threads first and reveals database content when the database tab is selected', async () => {
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Threads',
      'Database',
      'Prompts',
    ]);
    expect(screen.getByRole('tablist', { name: 'Library tabs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Prompts' })).toBeInTheDocument();
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

  it('uses a restrained primary tint for whichever Library tab is active', async () => {
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    const threadsTab = screen.getByRole('tab', { name: 'Threads' });
    const databaseTab = screen.getByRole('tab', { name: 'Database' });
    const promptsTab = screen.getByRole('tab', { name: 'Prompts' });
    for (const tab of [threadsTab, databaseTab, promptsTab]) {
      expect(tab).toHaveClass(
        'data-[state=active]:bg-primary/10',
        'data-[state=active]:text-primary'
      );
    }
    expect(threadsTab).toHaveAttribute('data-state', 'active');

    fireEvent.mouseDown(promptsTab, { button: 0, ctrlKey: false });
    await waitFor(() => {
      expect(promptsTab).toHaveAttribute('data-state', 'active');
    });
  });

  it('preloads the database chunk when requested', async () => {
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        preloadDatabaseTabOnMount
        promptsContent={<div>Prompts content</div>}
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
        promptsContent={<div>Prompts content</div>}
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

  it('retries the database prefetch after a transient preload failure', async () => {
    mockPreloadDatabaseTab
      .mockRejectedValueOnce(new Error('transient chunk load failure'))
      .mockResolvedValueOnce(undefined);

    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    const databaseTab = screen.getByRole('tab', { name: 'Database' });

    fireEvent.pointerEnter(databaseTab);
    await waitFor(() => {
      expect(mockPreloadDatabaseTab).toHaveBeenCalledTimes(1);
    });

    fireEvent.focus(databaseTab);
    await waitFor(() => {
      expect(mockPreloadDatabaseTab).toHaveBeenCalledTimes(2);
    });
  });

  it('reveals prompt content and persists the selected prompts tab across remounts', async () => {
    const { unmount } = render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(screen.queryByText('Prompts content')).not.toBeInTheDocument();

    const promptsTab = screen.getByRole('tab', { name: 'Prompts' });
    fireEvent.mouseDown(promptsTab, { button: 0, ctrlKey: false });

    await waitFor(() => {
      expect(promptsTab).toHaveAttribute('data-state', 'active');
    });
    expect(screen.getByText('Prompts content')).toBeVisible();

    unmount();

    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(screen.getByRole('tab', { name: 'Prompts' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Prompts content')).toBeVisible();
  });

  it('keeps database tab state mounted after the first visit', async () => {
    render(
      <AgentSidebarPanel
        databaseContent={<input aria-label="Database search" defaultValue="persisted query" />}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    const databaseTab = screen.getByRole('tab', { name: 'Database' });
    fireEvent.mouseDown(databaseTab, { button: 0, ctrlKey: false });

    const searchField = await screen.findByRole('textbox', { name: 'Database search' });
    fireEvent.change(searchField, { target: { value: 'keep me' } });
    expect(searchField).toHaveValue('keep me');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Threads' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText('Threads content')).toBeVisible();
    expect(searchField).not.toBeVisible();

    fireEvent.mouseDown(databaseTab, { button: 0, ctrlKey: false });
    expect(await screen.findByRole('textbox', { name: 'Database search' })).toHaveValue('keep me');
  });

  it('keeps prompts tab state mounted after the first visit', async () => {
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<input aria-label="Prompt library search" defaultValue="" />}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(
      screen.queryByRole('textbox', { name: 'Prompt library search' })
    ).not.toBeInTheDocument();

    const promptsTab = screen.getByRole('tab', { name: 'Prompts' });
    fireEvent.mouseDown(promptsTab, { button: 0, ctrlKey: false });

    const searchField = await screen.findByRole('textbox', { name: 'Prompt library search' });
    fireEvent.change(searchField, { target: { value: 'contextual clip' } });
    expect(searchField).toHaveValue('contextual clip');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Threads' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText('Threads content')).toBeVisible();
    expect(searchField).not.toBeVisible();

    fireEvent.mouseDown(promptsTab, { button: 0, ctrlKey: false });
    expect(await screen.findByRole('textbox', { name: 'Prompt library search' })).toHaveValue(
      'contextual clip'
    );
  });

  it('reports actual prompt-tab activity while preserving the mounted prompt surface', async () => {
    const activity: boolean[] = [];
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={(isActive) => {
          activity.push(isActive);
          return <input aria-label="Activity-aware prompt search" defaultValue="" />;
        }}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(activity.at(-1)).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Activity-aware prompt search' })).toBeNull();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Prompts' }), {
      button: 0,
      ctrlKey: false,
    });
    const searchField = await screen.findByRole('textbox', {
      name: 'Activity-aware prompt search',
    });
    expect(activity.at(-1)).toBe(true);
    fireEvent.change(searchField, { target: { value: 'preserve this' } });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Threads' }), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() => {
      expect(activity.at(-1)).toBe(false);
    });
    expect(searchField).not.toBeVisible();
    expect(searchField).toHaveValue('preserve this');
  });

  it('migrates the legacy tools panel tab and removes the old storage key', () => {
    window.localStorage.setItem(
      'tools-panel.v1',
      JSON.stringify({
        state: { activeTab: 'database' },
        version: 2,
      })
    );

    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(screen.getByRole('tab', { name: 'Database' })).toHaveAttribute('data-state', 'active');
    expect(window.localStorage.getItem('tools-panel.v1')).toBeNull();
    expect(window.localStorage.getItem('brainstrike.agent-sidebar-tab.v1')).toBe(
      JSON.stringify('database')
    );
  });

  it('falls back to the default tab when legacy tools panel storage is corrupted', () => {
    window.localStorage.setItem('tools-panel.v1', '{not valid json');

    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(screen.getByRole('tab', { name: 'Threads' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Threads content')).toBeVisible();
    expect(window.localStorage.getItem('tools-panel.v1')).toBeNull();
    expect(window.localStorage.getItem('brainstrike.agent-sidebar-tab.v1')).toBeNull();
  });
});
