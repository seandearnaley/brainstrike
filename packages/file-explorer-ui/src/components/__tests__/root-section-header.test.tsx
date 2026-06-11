import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RootSectionHeader } from '../root-section-header';

describe('RootSectionHeader', () => {
  it('renders the display name', () => {
    render(
      <RootSectionHeader displayName="my-project" isCollapsed={false} onToggleCollapse={vi.fn()} />
    );

    expect(screen.getByText('my-project')).toBeInTheDocument();
  });

  it('has data-testid="root-section-header"', () => {
    render(
      <RootSectionHeader displayName="my-project" isCollapsed={false} onToggleCollapse={vi.fn()} />
    );

    expect(screen.getByTestId('root-section-header')).toBeInTheDocument();
  });

  it('calls onToggleCollapse when clicked', async () => {
    const user = userEvent.setup();
    const onToggleCollapse = vi.fn();

    render(
      <RootSectionHeader
        displayName="my-project"
        isCollapsed={false}
        onToggleCollapse={onToggleCollapse}
      />
    );

    await user.click(screen.getByTestId('root-section-header'));
    expect(onToggleCollapse).toHaveBeenCalledOnce();
  });

  it('shows collapse indicator when isCollapsed is false', () => {
    render(
      <RootSectionHeader displayName="my-project" isCollapsed={false} onToggleCollapse={vi.fn()} />
    );

    expect(screen.getByLabelText(/collapse/i)).toBeInTheDocument();
  });

  it('shows expand indicator when isCollapsed is true', () => {
    render(
      <RootSectionHeader displayName="my-project" isCollapsed={true} onToggleCollapse={vi.fn()} />
    );

    expect(screen.getByLabelText(/expand/i)).toBeInTheDocument();
  });

  describe('disconnect button (Phase 5)', () => {
    it('does NOT render the disconnect button when onDisconnect is absent', () => {
      render(
        <RootSectionHeader
          displayName="my-project"
          isCollapsed={false}
          onToggleCollapse={vi.fn()}
        />
      );

      expect(screen.queryByLabelText('Disconnect folder')).toBeNull();
    });

    it('renders the disconnect button with aria-label "Disconnect folder" when onDisconnect is provided', () => {
      render(
        <RootSectionHeader
          displayName="my-project"
          isCollapsed={false}
          onDisconnect={vi.fn()}
          onToggleCollapse={vi.fn()}
        />
      );

      expect(screen.getByLabelText('Disconnect folder')).toBeInTheDocument();
    });

    it('clicking disconnect calls onDisconnect and does NOT toggle collapse', async () => {
      const user = userEvent.setup();
      const onDisconnect = vi.fn();
      const onToggleCollapse = vi.fn();

      render(
        <RootSectionHeader
          displayName="my-project"
          isCollapsed={false}
          onDisconnect={onDisconnect}
          onToggleCollapse={onToggleCollapse}
        />
      );

      await user.click(screen.getByLabelText('Disconnect folder'));
      expect(onDisconnect).toHaveBeenCalledOnce();
      // Sibling buttons: the disconnect click must not bubble into the toggle.
      expect(onToggleCollapse).not.toHaveBeenCalled();
    });
  });
});
