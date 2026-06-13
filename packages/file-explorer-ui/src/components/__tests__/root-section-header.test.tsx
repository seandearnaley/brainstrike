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
});
