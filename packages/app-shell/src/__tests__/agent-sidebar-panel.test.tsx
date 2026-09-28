import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, Suspense, use } from 'react';
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
      'Collections',
      'Prompts',
    ]);
    expect(screen.getByRole('tablist', { name: 'Library tabs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Prompts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Threads' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Threads content')).toBeVisible();
    expect(screen.queryByText('Database content')).not.toBeInTheDocument();

    const databaseTab = screen.getByRole('tab', { name: 'Collections' });
    fireEvent.mouseDown(databaseTab, { button: 0, ctrlKey: false });

    await waitFor(() => {
      expect(databaseTab).toHaveAttribute('data-state', 'active');
    });
    expect(await screen.findByText('Database content')).toBeVisible();
  });

  it('uses the shared panel-header (sm) switcher for every Library tab', async () => {
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(screen.getByTestId('agent-sidebar-tabs')).toHaveAttribute('data-size', 'sm');
    const threadsTab = screen.getByRole('tab', { name: 'Threads' });
    const collectionsTab = screen.getByRole('tab', { name: 'Collections' });
    const promptsTab = screen.getByRole('tab', { name: 'Prompts' });
    for (const tab of [threadsTab, collectionsTab, promptsTab]) {
      // Geometry and states come from the shared `sm` variant, never a local
      // override, so Library matches Explorer|Search and Git.
      expect(tab).toHaveAttribute('data-slot', 'tabs-trigger');
      expect(tab).toHaveAttribute('data-size', 'sm');
      expect(tab).not.toHaveClass(
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

  it('activates manually: arrows rove focus, Enter selects and persists', async () => {
    const user = userEvent.setup();
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    screen.getByRole('tab', { name: 'Threads' }).focus();
    await user.keyboard('{ArrowRight}');

    const collectionsTab = screen.getByRole('tab', { name: 'Collections' });
    expect(collectionsTab).toHaveFocus();
    expect(collectionsTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByText('Database content')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('brainstrike.agent-sidebar-tab.v1')).toBeNull();

    await user.keyboard('{Enter}');

    expect(collectionsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Database content')).toBeVisible();
    expect(window.localStorage.getItem('brainstrike.agent-sidebar-tab.v1')).toBe(
      JSON.stringify('database')
    );
  });

  it('switches in a transition and marks the incoming trigger data-pending until it commits', async () => {
    let resolvePrompts: () => void = () => undefined;
    const promptsReady = new Promise<void>((resolve) => {
      resolvePrompts = resolve;
    });
    function SlowPrompts(): ReactElement {
      use(promptsReady);
      return <div>Prompts content</div>;
    }

    render(
      <Suspense fallback={<div>Library fallback</div>}>
        <AgentSidebarPanel
          databaseContent={<div>Database content</div>}
          promptsContent={<SlowPrompts />}
          threadsContent={<div>Threads content</div>}
        />
      </Suspense>
    );

    const threadsTab = screen.getByRole('tab', { name: 'Threads' });
    const promptsTab = screen.getByRole('tab', { name: 'Prompts' });
    expect(promptsTab).not.toHaveAttribute('data-pending');

    // Awaited: React only retries a suspended render that `act` is awaiting.
    await act(async () => {
      fireEvent.mouseDown(promptsTab, { button: 0, ctrlKey: false });
    });

    // The suspended transition keeps the committed tab on screen instead of
    // blanking the Library behind a fallback; only the incoming trigger says so.
    expect(promptsTab).toHaveAttribute('data-pending');
    expect(promptsTab).toHaveAttribute('data-state', 'inactive');
    expect(threadsTab).toHaveAttribute('data-state', 'active');
    expect(threadsTab).not.toHaveAttribute('data-pending');
    expect(screen.getByText('Threads content')).toBeVisible();
    expect(screen.queryByText('Library fallback')).not.toBeInTheDocument();

    await act(async () => {
      resolvePrompts();
      await promptsReady;
    });

    await waitFor(() => {
      expect(promptsTab).toHaveAttribute('data-state', 'active');
    });
    expect(promptsTab).not.toHaveAttribute('data-pending');
    expect(screen.getByText('Prompts content')).toBeVisible();
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
    // Preloading also mounts the panel ahead of activation, hidden.
    expect(screen.getByText('Database content')).toBeInTheDocument();
    expect(screen.getByText('Database content')).not.toBeVisible();
    expect(screen.getByTestId('database-tab-content')).toHaveAttribute('hidden');
  });

  it('prefetches the database chunk on pointer and keyboard intent', async () => {
    render(
      <AgentSidebarPanel
        databaseContent={<div>Database content</div>}
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    const databaseTab = screen.getByRole('tab', { name: 'Collections' });

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

    const databaseTab = screen.getByRole('tab', { name: 'Collections' });

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

    const databaseTab = screen.getByRole('tab', { name: 'Collections' });
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

    expect(screen.getByRole('tab', { name: 'Collections' })).toHaveAttribute(
      'data-state',
      'active'
    );
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
