import { fireEvent, render, screen } from '@testing-library/react';
import { File } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { areTabStripItemsEqual } from '../tab-strip-item-equality';
import { TabStripTab, type TabStripTabProps } from '../tab-strip-tab';
import type { TabStripItem } from '../types';

const baseItem: TabStripItem = {
  closable: true,
  icon: File,
  id: 'gamma',
  label: 'gamma.md',
  panelDomId: 'panel-gamma',
  tabDomId: 'tab-gamma',
};

function renderTab(overrides: Partial<TabStripTabProps> = {}) {
  const props: TabStripTabProps = {
    group: 'scroll',
    hasContextMenu: false,
    isActive: false,
    isTabStop: false,
    item: baseItem,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onContextMenu: vi.fn(),
    reorderInstanceId: null,
    ...overrides,
  };
  const view = render(
    <div role="tablist">
      <TabStripTab {...props} />
    </div>
  );
  return { ...view, props };
}

describe('TabStripTab', () => {
  it('renders an APG tab wired to its panel', () => {
    renderTab({ isActive: true, isTabStop: true });
    const tab = screen.getByRole('tab', { name: 'gamma.md' });
    expect(tab).toHaveAttribute('id', 'tab-gamma');
    expect(tab).toHaveAttribute('aria-controls', 'panel-gamma');
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toHaveAttribute('tabindex', '0');
    expect(tab).toHaveAttribute('aria-keyshortcuts', 'Delete');
  });

  it('keeps the close control out of the accessibility tree and the tab order', () => {
    const { container, props } = renderTab();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
    const close = container.querySelector<HTMLButtonElement>('[data-slot="tab-close"]');
    expect(close).toHaveAttribute('aria-hidden', 'true');
    expect(close).toHaveAttribute('tabindex', '-1');
    fireEvent.click(close as HTMLButtonElement);
    expect(props.onClose).toHaveBeenCalledWith('gamma');
    expect(props.onActivate).not.toHaveBeenCalled();
  });

  it('activates on click and closes on middle-click', () => {
    const { container, props } = renderTab();
    fireEvent.click(screen.getByRole('tab'));
    expect(props.onActivate).toHaveBeenCalledWith('gamma');
    const shell = container.querySelector('[data-slot="tab-shell"]') as HTMLElement;
    fireEvent(shell, new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true }));
    expect(props.onClose).toHaveBeenCalledWith('gamma');
  });

  it('offers no close affordance when the item or the strip cannot close', () => {
    const nonClosable = renderTab({ item: { ...baseItem, closable: false } });
    expect(nonClosable.container.querySelector('[data-slot="tab-close"]')).toBeNull();
    expect(screen.getByRole('tab')).not.toHaveAttribute('aria-keyshortcuts');
    nonClosable.unmount();
    const noStripClose = renderTab({ onClose: null });
    expect(noStripClose.container.querySelector('[data-slot="tab-close"]')).toBeNull();
  });

  it('puts status text in the accessible name and swaps the icon for the status icon', () => {
    const { container } = renderTab({ item: { ...baseItem, status: 'deleted' } });
    expect(screen.getByRole('tab', { name: 'gamma.md, deleted' })).toBeInTheDocument();
    expect(container.querySelector('[data-tab-status="deleted"]')).not.toBeNull();
  });

  it('lets an identity mark own its badge while the status still reaches the name', () => {
    const { container } = renderTab({
      item: { ...baseItem, mark: <span data-testid="mark" />, status: 'running' },
    });
    expect(screen.getByTestId('mark')).toBeInTheDocument();
    expect(container.querySelector('[data-tab-status]')).toBeNull();
    expect(screen.getByRole('tab', { name: 'gamma.md, running' })).toBeInTheDocument();
  });

  it('accepts a status label without a status for mark-owned states', () => {
    const { container } = renderTab({
      item: { ...baseItem, mark: <span data-testid="mark" />, statusLabel: 'finished, unseen' },
    });
    expect(screen.getByRole('tab', { name: 'gamma.md, finished, unseen' })).toBeInTheDocument();
    expect(container.querySelector('[data-tab-status]')).toBeNull();
  });

  it('applies the neutral raised surface when selected and identity tints when provided', () => {
    const neutral = renderTab({ isActive: true });
    const shell = neutral.container.querySelector('[data-slot="tab-shell"]');
    expect(shell).toHaveClass('bg-background', 'shadow-xs', 'ring-1');
    neutral.unmount();
    const tinted = renderTab({
      isActive: true,
      item: {
        ...baseItem,
        appearance: { idleClassName: 'bg-tint-idle', selectedClassName: 'bg-tint-on' },
      },
    });
    const tintedShell = tinted.container.querySelector('[data-slot="tab-shell"]');
    expect(tintedShell).toHaveClass('bg-tint-on');
    expect(tintedShell).not.toHaveClass('bg-background');
  });

  it('advertises its context menu only when the strip has one', () => {
    renderTab({ hasContextMenu: true });
    expect(screen.getByRole('tab')).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('keeps a data-testid passed through dataAttributes when no testId is given', () => {
    renderTab({ item: { ...baseItem, dataAttributes: { 'data-testid': 'from-attributes' } } });
    expect(screen.getByRole('tab')).toHaveAttribute('data-testid', 'from-attributes');
  });

  it('spreads consumer data attributes onto the tab button', () => {
    renderTab({ item: { ...baseItem, dataAttributes: { 'data-app-id': 'changes' } } });
    expect(screen.getByRole('tab')).toHaveAttribute('data-app-id', 'changes');
  });
});

describe('areTabStripItemsEqual', () => {
  it('treats value-equal items as equal and any field change as a change', () => {
    expect(areTabStripItemsEqual(baseItem, { ...baseItem })).toBe(true);
    expect(areTabStripItemsEqual(baseItem, { ...baseItem, label: 'other' })).toBe(false);
    expect(areTabStripItemsEqual(baseItem, { ...baseItem, status: 'loading' })).toBe(false);
    expect(
      areTabStripItemsEqual(
        { ...baseItem, dataAttributes: { 'data-x': '1' } },
        { ...baseItem, dataAttributes: { 'data-x': '1' } }
      )
    ).toBe(true);
    expect(
      areTabStripItemsEqual(
        { ...baseItem, appearance: { idleClassName: 'a', selectedClassName: 'b' } },
        { ...baseItem, appearance: { idleClassName: 'a', selectedClassName: 'c' } }
      )
    ).toBe(false);
  });
});
