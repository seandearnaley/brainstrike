import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, Suspense, use } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSidebarPanel } from '../agent-sidebar-panel';

describe('AgentSidebarPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows Threads first among exactly two Library tabs', () => {
    render(
      <AgentSidebarPanel
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Threads',
      'Prompts',
    ]);
    expect(screen.getByRole('tablist', { name: 'Library tabs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Threads' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Threads content')).toBeVisible();
    expect(screen.queryByText('Prompts content')).not.toBeInTheDocument();
  });

  it.each(['brainstrike.agent-sidebar-tab.v1', 'brainstrike.agent-sidebar-tab.v2'])(
    'opens Threads when %s still holds the retired Collections tab',
    (key) => {
      window.localStorage.setItem(key, JSON.stringify('database'));

      render(
        <AgentSidebarPanel
          promptsContent={<div>Prompts content</div>}
          threadsContent={<div>Threads content</div>}
        />
      );

      expect(screen.getByRole('tab', { name: 'Threads' })).toHaveAttribute('data-state', 'active');
      expect(screen.getByText('Threads content')).toBeVisible();
    }
  );

  it('uses the shared panel-header (sm) switcher for every Library tab', async () => {
    render(
      <AgentSidebarPanel
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(screen.getByTestId('agent-sidebar-tabs')).toHaveAttribute('data-size', 'sm');
    const threadsTab = screen.getByRole('tab', { name: 'Threads' });
    const promptsTab = screen.getByRole('tab', { name: 'Prompts' });
    for (const tab of [threadsTab, promptsTab]) {
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
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    act(() => screen.getByRole('tab', { name: 'Threads' }).focus());
    await user.keyboard('{ArrowRight}');

    const promptsTab = screen.getByRole('tab', { name: 'Prompts' });
    expect(promptsTab).toHaveFocus();
    expect(promptsTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByText('Prompts content')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('brainstrike.agent-sidebar-tab.v2')).toBeNull();

    await user.keyboard('{Enter}');

    expect(promptsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Prompts content')).toBeVisible();
    expect(window.localStorage.getItem('brainstrike.agent-sidebar-tab.v2')).toBe(
      JSON.stringify('prompts')
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

    // Re-selecting the committed tab mid-switch is not a change (Radix emits
    // none), so the pending mark never lands on the tab that is already shown.
    await act(async () => {
      fireEvent.mouseDown(threadsTab, { button: 0, ctrlKey: false });
    });
    expect(threadsTab).not.toHaveAttribute('data-pending');
    expect(promptsTab).toHaveAttribute('data-pending');

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

  it('reveals prompt content and persists the selected prompts tab across remounts', async () => {
    const { unmount } = render(
      <AgentSidebarPanel
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
        promptsContent={<div>Prompts content</div>}
        threadsContent={<div>Threads content</div>}
      />
    );

    expect(screen.getByRole('tab', { name: 'Prompts' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Prompts content')).toBeVisible();
  });

  it.each(['Prompts'])('keeps Threads mounted when switching through %s', async (destination) => {
    render(
      <AgentSidebarPanel
        promptsContent={<div>Prompts content</div>}
        threadsContent={<input aria-label="Thread search" defaultValue="" />}
      />
    );
    const search = screen.getByRole('textbox', { name: 'Thread search' });
    fireEvent.change(search, { target: { value: 'retain thread state' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: destination }), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: destination })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    );
    expect(search).toBeInTheDocument();
    expect(search).not.toBeVisible();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Threads' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByRole('textbox', { name: 'Thread search' })).toBe(search);
    expect(search).toHaveValue('retain thread state');
  });

  it('keeps prompts tab state mounted after the first visit', async () => {
    render(
      <AgentSidebarPanel
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
        promptsContent={(isActive) => {
          activity.push(isActive);
          return <input aria-label="Activity-aware prompt search" defaultValue="" />;
        }}
        threadsContent={<div>Threads content</div>}
      />
    );

    // The Prompts panel is behind `TabPanelBoundary` inside `TabsContent
    // keepMounted`, which mounts children only on first activation, so the
    // callback has not run yet.
    expect(activity).toEqual([]);
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
});

describe('AgentSidebarPanel crash containment', () => {
  let shouldThrowPrompts = true;

  function FlakyPrompts(): ReactElement {
    if (shouldThrowPrompts) {
      throw new Error('Prompts panel exploded');
    }
    return <div>Prompts content</div>;
  }

  beforeEach(() => {
    shouldThrowPrompts = true;
    window.localStorage.clear();
    // TabPanelBoundary logs the caught error through createLogger; React also
    // warns to console.error for the uncaught-error case this test starts RED
    // from. Both are expected noise, not assertions.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('contains a Prompts panel crash to its own boundary, keeps the switcher and Threads working, and Reload tab remounts it', async () => {
    render(
      <AgentSidebarPanel
        promptsContent={<FlakyPrompts />}
        threadsContent={<div>Threads content</div>}
      />
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Prompts' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Prompts stopped working');

    // The switcher and the other panels stay interactive.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Threads' }), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Threads' })).toHaveAttribute('data-state', 'active');
    });
    expect(screen.getByText('Threads content')).toBeVisible();

    // "Reload tab" remounts the crashed panel.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Prompts' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    shouldThrowPrompts = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reload tab' }));
    expect(screen.getByText('Prompts content')).toBeVisible();
  });
});
