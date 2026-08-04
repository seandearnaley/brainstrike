import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';
import { WorkspacePanelTabs } from '../workspace-panel-tabs';

describe('WorkspacePanelTabs', () => {
  beforeEach(() => {
    useChangesNavigationStore.setState({
      activeChangeset: null,
      handoffThreadIdentity: null,
      openRequestId: 0,
    });
  });

  it('renders no tab chrome and just the context explorer content when changesPageContent is absent (capability gate)', () => {
    render(<WorkspacePanelTabs contextExplorerContent={<div>Context explorer content</div>} />);

    expect(screen.getByText('Context explorer content')).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Changes' })).not.toBeInTheDocument();
  });

  it('shows Context Explorer as the default active tab, with Changes present but hidden', () => {
    render(
      <WorkspacePanelTabs
        changesPageContent={<div>Changes content</div>}
        contextExplorerContent={<div>Context explorer content</div>}
      />
    );

    expect(screen.getByRole('tab', { name: 'Context Explorer' })).toHaveAttribute(
      'data-state',
      'active'
    );
    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('data-state', 'inactive');
    expect(screen.getByText('Context explorer content')).toBeVisible();
    // Not mounted yet — the Changes tab lazily mounts on first open (mirrors
    // the old KeepMountedRoute contract for the top-level Changes route).
    expect(screen.queryByText('Changes content')).not.toBeInTheDocument();
  });

  it('switches to the Changes tab on click and keeps Context Explorer mounted-but-hidden', () => {
    render(
      <WorkspacePanelTabs
        changesPageContent={<div>Changes content</div>}
        contextExplorerContent={<div>Context explorer content</div>}
      />
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Changes' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Changes content')).toBeVisible();
    // Context Explorer stays in the DOM (mounted-but-hidden), not unmounted —
    // it owns file-tree/open-file/scroll state that must survive the switch.
    expect(screen.getByText('Context explorer content')).not.toBeVisible();
  });

  it('keeps the Changes tab mounted after switching back to Context Explorer', () => {
    render(
      <WorkspacePanelTabs
        changesPageContent={<div>Changes content</div>}
        contextExplorerContent={<div>Context explorer content</div>}
      />
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Changes' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Context Explorer' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByRole('tab', { name: 'Context Explorer' })).toHaveAttribute(
      'data-state',
      'active'
    );
    expect(screen.getByText('Context explorer content')).toBeVisible();
    expect(screen.getByText('Changes content')).not.toBeVisible();
  });

  it('switches to the Changes tab when an external caller opens a changeset via the navigation store', () => {
    render(
      <WorkspacePanelTabs
        changesPageContent={<div>Changes content</div>}
        contextExplorerContent={<div>Context explorer content</div>}
      />
    );

    expect(screen.queryByText('Changes content')).not.toBeInTheDocument();

    act(() => {
      useChangesNavigationStore
        .getState()
        .openChangeset({ kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' });
    });

    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Changes content')).toBeVisible();
  });

  it('re-switches to the Changes tab on a second identical open request even after the user navigated away', () => {
    render(
      <WorkspacePanelTabs
        changesPageContent={<div>Changes content</div>}
        contextExplorerContent={<div>Context explorer content</div>}
      />
    );
    const changeset = { kind: 'agent-run' as const, runId: 'run-1', threadId: 'thread-1' };

    act(() => {
      useChangesNavigationStore.getState().openChangeset(changeset);
    });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Context Explorer' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('data-state', 'inactive');

    act(() => {
      useChangesNavigationStore.getState().openChangeset(changeset);
    });

    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('data-state', 'active');
  });

  it('does not switch tabs when the navigation store is used without a Changes surface present', () => {
    render(<WorkspacePanelTabs contextExplorerContent={<div>Context explorer content</div>} />);

    act(() => {
      useChangesNavigationStore
        .getState()
        .openChangeset({ kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' });
    });

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByText('Context explorer content')).toBeVisible();
  });
});
