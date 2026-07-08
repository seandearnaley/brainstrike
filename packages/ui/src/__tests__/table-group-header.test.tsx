import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TableGroupHeader } from '../table-group-header';

function renderGroupHeader(props: Parameters<typeof TableGroupHeader>[0]) {
  return render(
    <table>
      <tbody>
        <TableGroupHeader {...props} />
      </tbody>
    </table>
  );
}

describe('TableGroupHeader', () => {
  const baseProps = {
    groupKey: '1',
    groupLabel: 'Group 1',
    isCollapsed: false,
    isFullySelected: false,
    isPartiallySelected: false,
    onSelectionChange: vi.fn(),
    onToggleCollapse: vi.fn(),
  };

  it('renders label, icon and stats', () => {
    renderGroupHeader({ ...baseProps, icon: <span>icon</span>, stats: <span>5 items</span> });
    expect(screen.getByText('Group 1')).toBeInTheDocument();
    expect(screen.getByText('icon')).toBeInTheDocument();
    expect(screen.getByText('5 items')).toBeInTheDocument();
  });

  it('calls onToggleCollapse when button clicked', async () => {
    const user = userEvent.setup();
    const onToggleCollapse = vi.fn();
    renderGroupHeader({ ...baseProps, onToggleCollapse });
    const button = screen.getByRole('button', { name: 'Collapse group Group 1' });
    await user.click(button);
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it('calls onSelectionChange when checkbox toggled', async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderGroupHeader({ ...baseProps, onSelectionChange });
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);
    expect(onSelectionChange).toHaveBeenCalled();
  });

  it('sets aria-expanded based on isCollapsed', () => {
    const { rerender } = renderGroupHeader({ ...baseProps, isCollapsed: true });
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <table>
        <tbody>
          <TableGroupHeader {...baseProps} isCollapsed={false} />
        </tbody>
      </table>
    );
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks checkbox indeterminate when isPartiallySelected', () => {
    renderGroupHeader({ ...baseProps, isPartiallySelected: true });
    const checkbox = screen.getByRole('checkbox');
    // Radix UI uses data-state attribute to indicate indeterminate state
    expect(checkbox).toHaveAttribute('data-state', 'indeterminate');
  });
});
